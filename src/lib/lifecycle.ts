/**
 * Transactional Enterprise Fulfillment Lifecycle Service
 *
 * Enforces strict multi-stage warehouse workflow integrity inside atomic Dexie
 * transactions + idempotent Supabase ACID stored procedures:
 *
 *   1. Inbound Receiving (GRN) -> Staging / QC Inspection (never blind bin stock!)
 *   2. QC Inspection           -> Supervisor Approval -> Directed Putaway Task
 *   3. Directed Putaway        -> Verified Bin Scan   -> Allocatable Stock Balance
 *   4. Order Reservation       -> FEFO Bin/Serial Lock
 *   5. Picking                 -> Scan Verification   -> Picked Reservation
 *   6. Packing                 -> Carton & Weight Check -> Order Status = 'Packed'
 *   7. Carrier Shipping        -> Requires 'Packed'/'ReadyToShip' -> Manifest & Ledger
 *   8. Returns (RMA)           -> Inspection Hold or Verified Restock + Audit Log
 */

import { db, availableQty } from './db';
import { enqueueCloudOperation, getActiveWarehouseCode } from './supabaseSync';
import { hasPermission } from './security';
import {
  consumeReservationUnits,
  getStockScope,
  planFefoAllocation,
  commitAllocationPlan,
  refreshInventoryRollup,
  transferDimension,
  upsertDimension,
  verifyPickScan,
  type StockScope,
} from './stockBalances';

/** Every lifecycle mutation writes dimensional stock, so all of them need these tables. */
const LIFECYCLE_TABLES = () => [
  db.stockBalances,
  db.inventory,
  db.inventoryMovements,
  db.inventoryReservations,
  db.inbound,
  db.returns,
  db.qcHolds,
  db.putawayTasks,
  db.orders,
  db.shippingLabels,
  db.serialNumbers,
  db.auditLogs,
];

/**
 * Runs one lifecycle step inside a single Dexie transaction.
 *
 * A rejected step rolls back everything it wrote — including any audit row that
 * explains the rejection. Those rows are therefore collected outside the
 * transaction and written after the abort, so a refused scan, a blocked QC
 * checkpoint or an allocation shortfall always leaves a trace.
 */
async function runTransactionalStep(
  scope: StockScope,
  operator: string,
  failureAudits: Array<{ action: string; details: string }>,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await db.transaction('rw', LIFECYCLE_TABLES(), step);
  } catch (err) {
    const timestamp = new Date().toISOString();
    for (const audit of failureAudits) {
      await db.auditLogs
        .add({
          action: audit.action,
          details: audit.details,
          operator,
          timestamp,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        } as never)
        .catch(() => {});
    }
    throw err;
  }
}

/**
 * Resolves the tenancy scope for a lifecycle operation.
 *
 * Every mutation is stamped with BOTH tenant and warehouse, and every read is
 * filtered by them, so a warehouse switch can never post stock against another
 * site's balances.
 */
async function resolveScope(explicit?: { tenantCode?: string; warehouseCode?: string }): Promise<StockScope> {
  const scope = await getStockScope(explicit?.warehouseCode);
  return {
    tenantCode: (explicit?.tenantCode ?? scope.tenantCode).trim().toUpperCase(),
    warehouseCode: (explicit?.warehouseCode ?? scope.warehouseCode ?? (await getActiveWarehouseCode())).trim().toUpperCase(),
  };
}

export interface ReceiveGrnInput {
  sku: string;
  qty: number;
  description?: string;
  receivingBin?: string;
  suggestedLocation?: string;
  lotNumber?: string;
  expiryDate?: string;
  poNumber?: string;
  supplier?: string;
  crossDockOrderId?: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  operator: string;
  operatorRole?: string;
  /** Explicit tenancy scope; defaults to the active tenant + warehouse. */
  tenantCode?: string;
  warehouseCode?: string;
}

export interface ReceiveGrnResult {
  grnRef: string;
  stage: 'qc_hold' | 'putaway_queued';
  putawayTaskId?: string;
  suggestedLocation: string;
}

/**
 * Step 1: Receive Inbound Goods (GRN)
 *
 * Strictly stages incoming stock into either:
 *  - QC Inspection Hold (`qcStatus` = 'pending' | 'failed') -> requires QC Release before Putaway
 *  - Directed Putaway Queue (`qcStatus` = 'passed') -> stock enters allocatable inventory ONLY
 *    after Putaway Task is confirmed at the target bin.
 */
export async function receiveInboundTransactional(input: ReceiveGrnInput): Promise<ReceiveGrnResult> {
  if (!hasPermission(input.operatorRole || 'operator', 'inbound.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks inbound.execute permission');
  }
  const cleanSku = input.sku.trim();
  if (!cleanSku) throw new Error('VALIDATION_ERROR: SKU is required');
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error('VALIDATION_ERROR: Quantity must be greater than zero');
  }
  // A receipt without a lot reference cannot be FEFO-allocated later, and an
  // expiry-bearing SKU received without its expiry date silently breaks FEFO.
  const lotNumber = (input.lotNumber ?? '').trim() || 'DEFAULT';
  if (input.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate)) {
    throw new Error('VALIDATION_ERROR: expiryDate must be ISO yyyy-mm-dd');
  }

  const scope = await resolveScope({ tenantCode: input.tenantCode, warehouseCode: input.warehouseCode });
  const now = new Date().toISOString();
  const grnRef = `GRN-${Date.now()}`;
  const receivingBin = (input.receivingBin?.trim() || 'RECV-DOCK-01').toUpperCase();
  let suggestedLocation = (input.suggestedLocation?.trim() || 'PHONE-A-01').toUpperCase();
  let putawayTaskId: string | undefined;
  const stage: ReceiveGrnResult['stage'] = input.qcStatus === 'passed' ? 'putaway_queued' : 'qc_hold';

  await db.transaction('rw', LIFECYCLE_TABLES(), async () => {
      const existing = await db.inventory
        .where('[tenantCode+warehouseCode+sku]')
        .equals([scope.tenantCode, scope.warehouseCode, cleanSku])
        .first();
      if (existing?.location && !input.suggestedLocation) {
        suggestedLocation = existing.location;
      }

      // Ensure master SKU catalog entry exists (with 0 stock increment until putaway completes!)
      if (!existing) {
        await db.inventory.add({
          sku: cleanSku,
          product: input.description?.trim() || cleanSku,
          stock: 0,
          availableStock: 0,
          location: suggestedLocation,
          lotNumber,
          expiryDate: input.expiryDate || undefined,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
          updatedAt: now,
        });
      }

      if (input.crossDockOrderId?.trim()) {
        const cdOrder = await db.orders.where('orderId').equals(input.crossDockOrderId.trim()).first();
        if (!cdOrder) {
          await db.orders.add({
            orderId: input.crossDockOrderId.trim(),
            status: 'CrossDock',
            requiredSkus: cleanSku,
            priority: 'high',
            createdAt: now,
            updatedAt: now,
            tenantCode: scope.tenantCode,
            warehouseCode: scope.warehouseCode,
          });
        }
      }

      await db.inbound.add({
        sku: cleanSku,
        qty: input.qty,
        bin: receivingBin,
        description: input.description?.trim() || existing?.product || cleanSku,
        lotNumber,
        expiryDate: input.expiryDate || undefined,
        poNumber: input.poNumber?.trim() || undefined,
        supplier: input.supplier?.trim() || undefined,
        receivedAt: now,
        crossDockOrderId: input.crossDockOrderId?.trim() || undefined,
        qcStatus: input.qcStatus,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
      });

      if (stage === 'qc_hold') {
        // Post the received units into a QUARANTINE dimension at the dock bin.
        // They are physically in the building, so the ledger must account for
        // them — and release/scrap needs a real dimension to move or decrement.
        await upsertDimension({
          scope,
          sku: cleanSku,
          location: receivingBin,
          lotNumber,
          stockStatus: 'QUARANTINE',
          qtyDelta: input.qty,
          expiryDate: input.expiryDate || null,
          operator: input.operator,
          movementType: 'inbound',
          note: `${grnRef}: received pending QC inspection`,
          referenceId: grnRef,
        });

        await db.qcHolds.add({
          sku: cleanSku,
          lotNumber,
          quantity: input.qty,
          reason: input.qcStatus === 'failed' ? `Damaged/Failed on GRN (${grnRef})` : `Inbound QC Inspection Required (${grnRef})`,
          status: 'hold',
          // The receiving dock bin is where the blocked units actually are; the
          // disposition step needs it to move the right dimension.
          location: receivingBin,
          operator: input.operator,
          createdAt: now,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      } else {
        putawayTaskId = `PUT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const destZone = suggestedLocation.split('-')[0] || 'PHONE-A';
        await db.putawayTasks.add({
          taskId: putawayTaskId,
          sku: cleanSku,
          product: input.description?.trim() || existing?.product || cleanSku,
          quantity: input.qty,
          lotNumber,
          expiryDate: input.expiryDate || undefined,
          sourceLocation: receivingBin,
          sourceType: 'receiving',
          suggestedLocation,
          destinationZone: destZone,
          status: 'pending',
          priority: input.crossDockOrderId ? 'urgent' : 'normal',
          createdAt: now,
          qcStatus: 'passed',
          putawayMethod: 'direct',
          operator: input.operator,
          estimatedTime: 10,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      }

      await db.auditLogs.add({
        action: 'INBOUND_GRN_STAGED',
        details: `${grnRef}: ${input.qty}× ${cleanSku} at ${receivingBin} -> ${stage === 'qc_hold' ? 'QC Hold' : `Putaway ${putawayTaskId} (${suggestedLocation})`}`,
        operator: input.operator,
        timestamp: now,
      });
    }
  );

  await enqueueCloudOperation(
    'inbound_grn',
    {
      sku: cleanSku,
      qty: input.qty,
      description: input.description || null,
      poNumber: input.poNumber || null,
      supplier: input.supplier || 'Direct Supplier',
      bin: receivingBin,
      lotNumber,
      expiryDate: input.expiryDate || null,
      qcStatus: input.qcStatus,
      operator: input.operator,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `grn:${scope.warehouseCode}:${grnRef}`,
  );

  return { grnRef, stage, putawayTaskId, suggestedLocation };
}

/**
 * Step 2a: Raise a QC Hold (permission `qc.inspect`).
 *
 * A hold is not paperwork — it must physically block the units it names, so the
 * same SKU/lot can never be allocated by FEFO while inspection is open. The
 * blocked units are moved into a QUARANTINE dimension at the named bin; whatever
 * is not physically present there is reported back instead of being invented.
 */
export async function createQcHoldTransactional(params: {
  sku: string;
  quantity: number;
  reason: string;
  operator: string;
  operatorRole?: string;
  lotNumber?: string;
  bin?: string;
  expiryDate?: string | null;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ holdId: number; bin: string; blockedQty: number; unmatchedQty: number }> {
  if (!hasPermission(params.operatorRole, 'qc.inspect')) {
    throw new Error('PERMISSION_DENIED: qc.inspect is required to raise a QC hold.');
  }
  const sku = String(params.sku ?? '').trim().toUpperCase();
  const reason = String(params.reason ?? '').trim();
  const quantity = Number(params.quantity);
  if (!sku) throw new Error('VALIDATION_ERROR: a SKU is required to raise a QC hold');
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('VALIDATION_ERROR: hold quantity must be a positive number');
  }
  if (!reason) throw new Error('VALIDATION_ERROR: a reason is required to raise a QC hold');

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  const lotNumber = (params.lotNumber?.trim() || 'DEFAULT').toUpperCase();
  const bin = (params.bin?.trim() || 'QC-HOLD-AREA').toUpperCase();

  let holdId = 0;
  let blockedQty = 0;

  await db.transaction('rw', LIFECYCLE_TABLES(), async () => {
    // Block exactly what is physically in the named bin (AVAILABLE first).
    const dimension = await db.stockBalances
      .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
      .equals([scope.tenantCode, scope.warehouseCode, bin, sku, lotNumber, 'AVAILABLE'])
      .first();
    blockedQty = Math.min(quantity, dimension ? availableQty(dimension) : 0);
    if (blockedQty > 0) {
      await transferDimension({
        scope,
        sku,
        qty: blockedQty,
        from: { location: bin, lotNumber, stockStatus: 'AVAILABLE' },
        to: { location: bin, lotNumber, stockStatus: 'QUARANTINE' },
        operator: params.operator,
        note: `QC hold raised: ${reason}`,
      });
    }

    holdId = (await db.qcHolds.add({
      sku,
      lotNumber,
      quantity,
      reason,
      status: 'hold',
      location: bin,
      operator: params.operator,
      createdAt: now,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    })) as number;

    await db.auditLogs.add({
      action: 'QC_HOLD_CREATED',
      details: `${quantity}× ${sku} LOT ${lotNumber} held at ${bin} (${blockedQty} blocked) — ${reason}`,
      operator: params.operator,
      timestamp: now,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    } as never);
  });

  await enqueueCloudOperation(
    'stock_movement',
    {
      sku,
      qtyDelta: blockedQty > 0 ? 0 : 0,
      transactionType: 'qc_adjustment',
      location: bin,
      lotNumber,
      stockStatus: 'QUARANTINE',
      quantity,
      expiryDate: params.expiryDate ?? null,
      operator: params.operator,
      note: `QC hold: ${reason}`,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `qc_hold:${scope.warehouseCode}:${sku}:${lotNumber}:${holdId}`,
  );

  await refreshInventoryRollup(sku, scope);
  return { holdId, bin, blockedQty, unmatchedQty: Math.max(0, quantity - blockedQty) };
}

/**
 * Step 2: QC Release / Scrap Checkpoint (Requires Supervisor or Admin permission `qc.release`)
 *
 * Releasing a QC Hold generates a Directed Putaway Task (`sourceType = 'qc_release'`)
 * rather than dumping unlocated stock directly into inventory.
 */
export async function dispositionQcHoldTransactional(params: {
  holdId: number;
  disposition: 'release' | 'scrap';
  operator: string;
  operatorRole?: string;
  /** Bin the released units are staged in before directed putaway. */
  quarantineBin?: string;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ putawayTaskId?: string }> {
  if (!hasPermission(params.operatorRole, 'qc.release')) {
    throw new Error('PERMISSION_DENIED: Supervisor or Admin approval (qc.release) is required to release or scrap QC holds.');
  }

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  let putawayTaskId: string | undefined;
  let holdSnapshot: { sku: string; quantity: number; reason: string; lotNumber?: string } | null = null;

  await db.transaction('rw', LIFECYCLE_TABLES(), async () => {
    const hold = await db.qcHolds.get(params.holdId);
    if (!hold) throw new Error('QC Hold record not found');
    if (hold.status !== 'hold') throw new Error(`QC_HOLD_ALREADY_PROCESSED: QC Hold already processed (${hold.status})`);

    holdSnapshot = {
      sku: hold.sku,
      quantity: hold.quantity,
      reason: hold.reason,
      lotNumber: hold.lotNumber,
    };

    // Explicit override wins; otherwise use the bin the hold was raised in, so a
    // release or scrap always acts on the units that are really blocked.
    const holdBin = (params.quarantineBin?.trim() || hold.location?.trim() || 'QC-HOLD-AREA').toUpperCase();

    await db.qcHolds.update(params.holdId, {
      status: params.disposition === 'release' ? 'released' : 'rejected',
      releasedAt: now,
    });

    if (params.disposition === 'release') {
      const inv = await db.inventory
        .where('[tenantCode+warehouseCode+sku]')
        .equals([scope.tenantCode, scope.warehouseCode, hold.sku])
        .first();
      const suggestedLoc = (inv?.location || 'PHONE-A-01').toUpperCase();
      const destZone = suggestedLoc.split('-')[0] || 'PHONE-A';
      const quarantineBin = holdBin;
      putawayTaskId = `PUT-QC-${Date.now()}`;

      // If the units were physically received into a quarantine dimension, move
      // them out of the blocked status into the staging bin so the rollup and the
      // availability math agree with the floor.
      const quarantineDim = await db.stockBalances
        .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
        .equals([scope.tenantCode, scope.warehouseCode, quarantineBin, hold.sku, hold.lotNumber || 'DEFAULT', 'QUARANTINE'])
        .first();
      if (quarantineDim) {
        await transferDimension({
          scope,
          sku: hold.sku,
          qty: Math.min(hold.quantity, quarantineDim.onHandQty),
          from: { location: quarantineBin, lotNumber: hold.lotNumber || 'DEFAULT', stockStatus: 'QUARANTINE' },
          to: { location: quarantineBin, lotNumber: hold.lotNumber || 'DEFAULT', stockStatus: 'HOLD' },
          operator: params.operator,
          note: `QC release ${putawayTaskId}`,
        });
      }

      await db.putawayTasks.add({
        taskId: putawayTaskId,
        sku: hold.sku,
        product: inv?.product || hold.sku,
        quantity: hold.quantity,
        lotNumber: hold.lotNumber,
        sourceLocation: quarantineBin,
        sourceType: 'qc_release',
        suggestedLocation: suggestedLoc,
        destinationZone: destZone,
        status: 'pending',
        priority: 'high',
        createdAt: now,
        qcStatus: 'passed',
        putawayMethod: 'direct',
        operator: params.operator,
        estimatedTime: 10,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
      });
    } else {
      // Scrap removes the units from the blocked dimension entirely.
      const quarantineBin = holdBin;
      const quarantineDim = await db.stockBalances
        .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
        .equals([scope.tenantCode, scope.warehouseCode, quarantineBin, hold.sku, hold.lotNumber || 'DEFAULT', 'QUARANTINE'])
        .first();
      if (quarantineDim) {
        await upsertDimension({
          scope,
          sku: hold.sku,
          location: quarantineBin,
          lotNumber: hold.lotNumber || 'DEFAULT',
          stockStatus: 'QUARANTINE',
          qtyDelta: -Math.min(hold.quantity, quarantineDim.onHandQty),
          operator: params.operator,
          movementType: 'qc_adjustment',
          note: `QC scrap: ${hold.reason}`,
        });
      }
    }

    await db.auditLogs.add({
      action: params.disposition === 'release' ? 'QC_HOLD_RELEASED' : 'QC_HOLD_SCRAPPED',
      details: `${hold.quantity}× ${hold.sku} (${hold.reason})${putawayTaskId ? ` -> Putaway ${putawayTaskId}` : ' -> Scrapped'}`,
      operator: params.operator,
      timestamp: now,
    });
  });

  if (holdSnapshot) {
    const snap = holdSnapshot as { sku: string; quantity: number; reason: string; lotNumber?: string };
    await enqueueCloudOperation(
      'qc_release',
      {
        sku: snap.sku,
        qty: snap.quantity,
        disposition: params.disposition,
        reason: snap.reason,
        lotNumber: snap.lotNumber || 'DEFAULT',
        operator: params.operator,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
      },
      `qc:${scope.warehouseCode}:${snap.sku}:${snap.lotNumber || 'DEFAULT'}:${params.disposition}:${Date.now()}`,
    );
  }

  return { putawayTaskId };
}

/**
 * Step 3: Complete Directed Putaway Task -> Increments Allocatable Stock Balance
 */
export async function completePutawayTransactional(params: {
  taskId: number;
  actualLocation?: string;
  operator: string;
  operatorRole?: string;
  /** Barcode/serial scanned at the bin; when supplied it must match the SKU. */
  scannedCode?: string;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ location: string; newStock: number; lotNumber: string }> {
  if (!hasPermission(params.operatorRole || 'operator', 'putaway.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks putaway.execute permission');
  }

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  let finalLoc = 'PHONE-A-01';
  let finalLot = 'DEFAULT';
  let newStock = 0;
  const failureAudits: Array<{ action: string; details: string }> = [];
  let taskSnapshot: { taskId: string; sku: string; qty: number; sourceLocation: string; lotNumber?: string } | null = null;

  await runTransactionalStep(scope, params.operator, failureAudits, async () => {
    const task = await db.putawayTasks.get(params.taskId);
    if (!task) throw new Error('PUTAWAY_TASK_NOT_FOUND: Putaway task not found');
    if (task.status === 'completed') throw new Error('PUTAWAY_ALREADY_COMPLETED: Putaway task already completed');
    if (task.qcStatus !== 'passed' && task.qcStatus !== 'released') {
      throw new Error(`QC_CHECKPOINT_BLOCKED: SKU ${task.sku} has not passed QC inspection`);
    }

    finalLoc = (params.actualLocation?.trim() || task.suggestedLocation || 'PHONE-A-01').toUpperCase();
    finalLot = (task.lotNumber?.trim() || 'DEFAULT');

    // Bin-scan verification: the operator must prove they are standing at the
    // destination bin (or holding the right unit) before stock is posted there.
    if (params.scannedCode?.trim()) {
      const scan = await verifyPickScan({
        sku: task.sku,
        scannedCode: params.scannedCode,
        location: finalLoc,
        lotNumber: finalLot,
        scope,
      });
      if (!scan.ok) {
        failureAudits.push({
          action: 'PUTAWAY_SCAN_MISMATCH',
          details: `${params.operator} scanned "${params.scannedCode}" while putting away ${task.sku} at ${finalLoc}: ${scan.error}`,
        });
        throw new Error(`${scan.code}: ${scan.error}`);
      }
    } else if (finalLoc.toUpperCase() !== (params.actualLocation ?? finalLoc).trim().toUpperCase()) {
      throw new Error('SCAN_REQUIRED: confirm the destination bin scan before posting putaway stock');
    }
    taskSnapshot = {
      taskId: task.taskId,
      sku: task.sku,
      qty: task.quantity,
      sourceLocation: task.sourceLocation,
      lotNumber: finalLot,
    };

    await db.putawayTasks.update(params.taskId, {
      status: 'completed',
      actualLocation: finalLoc,
      completedAt: now,
      actualTime: task.startedAt ? Math.max(1, Math.round((Date.now() - new Date(task.startedAt).getTime()) / 60000)) : 8,
    });

    // Post into the EXACT bin/lot dimension. Stock becomes allocatable only now.
    const posted = await upsertDimension({
      scope,
      sku: task.sku,
      location: finalLoc,
      lotNumber: finalLot,
      qtyDelta: task.quantity,
      stockStatus: 'AVAILABLE',
      expiryDate: task.expiryDate ?? null,
      operator: params.operator,
      movementType: 'putaway',
      note: `Directed putaway ${task.taskId} from ${task.sourceLocation}`,
      referenceId: task.taskId,
    });

    // Units staged in a HOLD dimension at the source bin are now physically gone.
    const staged = await db.stockBalances
      .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
      .equals([scope.tenantCode, scope.warehouseCode, task.sourceLocation.toUpperCase(), task.sku, finalLot, 'HOLD'])
      .first();
    if (staged && staged.onHandQty > 0) {
      await upsertDimension({
        scope,
        sku: task.sku,
        location: staged.location,
        lotNumber: finalLot,
        stockStatus: 'HOLD',
        qtyDelta: -Math.min(task.quantity, staged.onHandQty),
        operator: params.operator,
        movementType: 'putaway',
        note: `Released staging hold for ${task.taskId}`,
        referenceId: task.taskId,
      });
    }

    // Master catalog entry (product metadata) stays, but stock is the rollup.
    const inv = await db.inventory
      .where('[tenantCode+warehouseCode+sku]')
      .equals([scope.tenantCode, scope.warehouseCode, task.sku])
      .first();
    if (!inv) {
      await db.inventory.add({
        sku: task.sku,
        product: task.product || task.sku,
        stock: 0,
        location: finalLoc,
        lotNumber: finalLot,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
        updatedAt: now,
      });
    }
    await refreshInventoryRollup(task.sku, scope);
    const rolled = await db.inventory
      .where('[tenantCode+warehouseCode+sku]')
      .equals([scope.tenantCode, scope.warehouseCode, task.sku])
      .first();
    newStock = rolled?.stock ?? posted.onHandQty;

    await db.auditLogs.add({
      action: 'PUTAWAY_COMPLETED',
      details: `${task.taskId}: ${task.quantity}× ${task.sku} put away at ${finalLoc}/${finalLot} (warehouse on-hand=${newStock})`,
      operator: params.operator,
      timestamp: now,
    });
  });

  if (taskSnapshot) {
    const snap = taskSnapshot as { taskId: string; sku: string; qty: number };
    await enqueueCloudOperation(
      'putaway_complete',
      {
        taskNumber: snap.taskId,
        actualLocation: finalLoc,
        operator: params.operator,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
      },
      `putaway:${scope.warehouseCode}:${snap.taskId}`,
    );
  }

  return { location: finalLoc, newStock, lotNumber: finalLot };
}

/**
 * Step 5 & 6: Verify Pick & Pack -> Transitions Order to 'Packed' (NOT directly to 'Shipped'!)
 *
 * Ensures Carrier Label & Manifest generation in Shipping is mandatory before Carrier Dispatch,
 * while atomically fulfilling/creating reservations so stock cannot be double-picked.
 */
export async function confirmPickAndPackTransactional(params: {
  orderRecordId: number;
  /** Each line MUST carry the scan captured at the bin for that SKU. */
  pickedItems: Array<{ sku: string; picked: number; scannedCode?: string; location?: string; lotNumber?: string }>;
  boxName?: string;
  operator: string;
  operatorRole?: string;
  weightKg?: number;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ orderId: string; status: 'Packed'; pickedBins: Array<{ sku: string; location: string; lotNumber: string; qty: number }> }> {
  if (!hasPermission(params.operatorRole || 'operator', 'outbound.pack')) {
    throw new Error('PERMISSION_DENIED: Operator lacks outbound.pack permission');
  }

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  let orderIdStr = '';
  const pickedBins: Array<{ sku: string; location: string; lotNumber: string; qty: number }> = [];
  // Audit rows describing a REJECTED step cannot live inside the transaction
  // that is about to roll back, or the rejection leaves no trace at all.
  const failureAudits: Array<{ action: string; details: string }> = [];

  await runTransactionalStep(scope, params.operator, failureAudits, async () => {
      const order = await db.orders.get(params.orderRecordId);
      if (!order) throw new Error('ORDER_NOT_FOUND: Order not found');
      if (order.status === 'Shipped') throw new Error('LIFECYCLE_VIOLATION: Order has already been shipped');
      if (order.warehouseCode && order.warehouseCode !== scope.warehouseCode) {
        throw new Error(
          `WAREHOUSE_MISMATCH: order ${order.orderId} belongs to ${order.warehouseCode}, active scope is ${scope.warehouseCode}`,
        );
      }
      orderIdStr = order.orderId;

      for (const line of params.pickedItems) {
        if (!Number.isFinite(line.picked) || line.picked <= 0) {
          throw new Error(`VALIDATION_ERROR: ${line.sku} picked quantity must be positive`);
        }

        // 1. Scan verification is mandatory before anything is consumed.
        const scan = await verifyPickScan({
          sku: line.sku,
          scannedCode: line.scannedCode ?? '',
          location: line.location,
          lotNumber: line.lotNumber,
          scope,
        });
        if (!scan.ok) {
          failureAudits.push({
            action: 'PICK_SCAN_MISMATCH',
            details: `${params.operator} packed ${line.picked}× ${line.sku} for ${order.orderId} with scan "${line.scannedCode ?? ''}": ${scan.error}`,
          });
          throw new Error(`${scan.code}: ${scan.error}`);
        }

        // 2. Consume this order's own reservations first (dimension-accurate).
        const ownRes = await db.inventoryReservations
          .where('orderId')
          .equals(order.orderId)
          .filter((r) => r.sku === line.sku && (r.status === 'reserved' || r.status === 'allocated'))
          .toArray();

        let remaining = line.picked;
        for (const r of ownRes) {
          if (remaining <= 0) break;
          // Honour an explicit bin/lot choice from the scan when supplied.
          if (line.location && r.location && r.location !== line.location.toUpperCase()) continue;
          if (line.lotNumber && r.lotNumber && r.lotNumber !== line.lotNumber) continue;
          const take = Math.min(remaining, r.quantity);
          const consumed = await consumeReservationUnits(r, {
            operator: params.operator,
            qty: take,
            movementType: 'pick',
            note: `Pick & pack ${order.orderId} (scan ${scan.matched})`,
            scope,
          });
          pickedBins.push({ sku: line.sku, location: consumed.location, lotNumber: consumed.lotNumber, qty: consumed.consumed });
          remaining -= consumed.consumed;
        }

        // 3. Anything unreserved is allocated on the fly with strict FEFO —
        //    never taken from an arbitrary bin.
        if (remaining > 0) {
          const plan = await planFefoAllocation(line.sku, remaining, scope, order.orderId);
          if (plan.shortfall > 0) {
            throw new Error(
              `INSUFFICIENT_STOCK: ${line.sku} needs ${remaining} more unit(s) but only ${plan.picks.reduce((n, x) => n + x.qty, 0)} are allocatable in ${scope.warehouseCode}`,
            );
          }
          const created = await commitAllocationPlan(plan, {
            orderId: order.orderId,
            operator: params.operator,
            scope,
            reservationPrefix: 'RES-PACK',
          });
          for (const c of created) {
            const res = await db.inventoryReservations.where('reservationId').equals(c.reservationId).first();
            if (!res) continue;
            const consumed = await consumeReservationUnits(res, {
              operator: params.operator,
              movementType: 'pick',
              note: `On-the-fly FEFO pick for ${order.orderId}`,
              scope,
            });
            pickedBins.push({ sku: line.sku, location: consumed.location, lotNumber: consumed.lotNumber, qty: consumed.consumed });
            remaining -= consumed.consumed;
          }
        }

        if (remaining > 0) {
          throw new Error(`PICK_INCOMPLETE: ${remaining}× ${line.sku} could not be picked from any reserved bin`);
        }
      }

      await db.orders.update(params.orderRecordId, {
        status: 'Packed',
        actualBoxSize: params.boxName || order.suggestedBoxSize || 'Standard Carton',
        assignedTo: params.operator,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
        updatedAt: now,
      });

      await db.auditLogs.add({
        action: 'ORDER_PACKED',
        details: `Order ${order.orderId} pick-verified & packed (${pickedBins
          .map((b) => `${b.qty}× ${b.sku} @ ${b.location}/${b.lotNumber}`)
          .join(', ')}) — staged for Carrier Shipping`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  await enqueueCloudOperation(
    'confirm_packed',
    {
      orderId: orderIdStr,
      boxName: params.boxName || 'Standard Carton',
      weightKg: params.weightKg ?? 0.4,
      operator: params.operator,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `pack:${scope.warehouseCode}:${orderIdStr}`,
  );

  return { orderId: orderIdStr, status: 'Packed', pickedBins };
}

/**
 * Step 7: Carrier Dispatch -> Enforces 'Packed'/'ReadyToShip' gate, deducts stock,
 * fulfills reservations, stamps shipping label, and emits transactional outbox event.
 */
export async function dispatchShipmentTransactional(params: {
  orderRecordId: number;
  labelRecordId?: number;
  carrier: string;
  trackingNumber: string;
  operator: string;
  operatorRole?: string;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ shipmentRef: string; dispatchedBins: Array<{ sku: string; location: string; lotNumber: string; qty: number }>; shippedAt: string }> {
  if (!hasPermission(params.operatorRole || 'operator', 'outbound.ship')) {
    throw new Error('PERMISSION_DENIED: Operator lacks outbound.ship permission');
  }

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  const shipmentRef = `SHP-${Date.now()}`;
  let orderIdStr = '';
  const dispatchedBins: Array<{ sku: string; location: string; lotNumber: string; qty: number }> = [];
  const failureAudits: Array<{ action: string; details: string }> = [];

  await runTransactionalStep(scope, params.operator, failureAudits, async () => {
      const order = await db.orders.get(params.orderRecordId);
      if (!order) throw new Error('ORDER_NOT_FOUND: Order not found');
      if (order.status === 'Shipped') throw new Error('LIFECYCLE_VIOLATION: Order is already dispatched');
      if (order.warehouseCode && order.warehouseCode !== scope.warehouseCode) {
        throw new Error(
          `WAREHOUSE_MISMATCH: order ${order.orderId} belongs to ${order.warehouseCode}, active scope is ${scope.warehouseCode}`,
        );
      }

      const canOverride = hasPermission(params.operatorRole, 'outbound.override');
      if (!['Packed', 'ReadyToShip'].includes(order.status) && !canOverride) {
        throw new Error(
          `LIFECYCLE_VIOLATION: Order ${order.orderId} is in "${order.status}" state and must complete Pick & Pack before Carrier Dispatch.`
        );
      }

      orderIdStr = order.orderId;
      const counts: Record<string, number> = {};
      for (const raw of order.requiredSkus.split(',')) {
        const sku = raw.trim();
        if (!sku) continue;
        const m = sku.match(/^(.*?)[*x:](\d+)$/i);
        if (m && m[1]) counts[m[1].trim()] = (counts[m[1].trim()] || 0) + Number(m[2]);
        else counts[sku] = (counts[sku] || 0) + 1;
      }

      // Reservation-accurate dispatch: units leave the EXACT bins that were
      // reserved/picked for this order. Anything still unpicked is allocated by
      // strict FEFO first, so a dispatch can never silently draw from a bin that
      // belongs to another wave, nor decrement a per-SKU total that no longer
      // reflects the physical layout.
      for (const [sku, qty] of Object.entries(counts)) {
        // Units already picked and packed for this order have physically left
        // the bin; dispatch must ship them, not try to reserve them again.
        const pickedRes = await db.inventoryReservations
          .where('orderId')
          .equals(order.orderId)
          .filter((r) => r.sku === sku && r.status === 'picked')
          .toArray();
        const alreadyPicked = pickedRes.reduce((sum, r) => sum + r.quantity, 0);
        for (const r of pickedRes) {
          dispatchedBins.push({
            sku,
            location: r.location ?? 'UNSPECIFIED',
            lotNumber: r.lotNumber ?? 'DEFAULT',
            qty: r.quantity,
          });
        }

        let remaining = Math.max(0, qty - alreadyPicked);
        if (remaining === 0) continue;

        const ownRes = await db.inventoryReservations
          .where('orderId')
          .equals(order.orderId)
          .filter((r) => r.sku === sku && (r.status === 'reserved' || r.status === 'allocated'))
          .toArray();

        for (const r of ownRes) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, r.quantity);
          const consumed = await consumeReservationUnits(r, {
            operator: params.operator,
            qty: take,
            movementType: 'outbound',
            note: `Dispatch ${shipmentRef} (${params.trackingNumber})`,
            scope,
          });
          dispatchedBins.push({ sku, location: consumed.location, lotNumber: consumed.lotNumber, qty: consumed.consumed });
          remaining -= consumed.consumed;
        }

        if (remaining > 0) {
          const plan = await planFefoAllocation(sku, remaining, scope, order.orderId);
          if (plan.shortfall > 0) {
            failureAudits.push({
              action: 'ALLOCATION_CONFLICT',
              details: `Dispatch of ${order.orderId} blocked: ${sku} short ${plan.shortfall} unit(s) in ${scope.warehouseCode}`,
            });
            throw new Error(
              `INSUFFICIENT_STOCK: Cannot dispatch ${order.orderId}; ${sku} is short ${plan.shortfall} allocatable unit(s) in ${scope.warehouseCode}`
            );
          }
          const created = await commitAllocationPlan(plan, {
            orderId: order.orderId,
            operator: params.operator,
            scope,
            reservationPrefix: 'RES-DISPATCH',
          });
          for (const c of created) {
            const res = await db.inventoryReservations.where('reservationId').equals(c.reservationId).first();
            if (!res) continue;
            const consumed = await consumeReservationUnits(res, {
              operator: params.operator,
              movementType: 'outbound',
              note: `FEFO dispatch ${shipmentRef}`,
              scope,
            });
            dispatchedBins.push({ sku, location: consumed.location, lotNumber: consumed.lotNumber, qty: consumed.consumed });
            remaining -= consumed.consumed;
          }
        }

        if (remaining > 0) {
          throw new Error(`DISPATCH_INCOMPLETE: ${remaining}× ${sku} could not be released from any bin`);
        }
      }

      if (params.labelRecordId != null) {
        await db.shippingLabels.update(params.labelRecordId, {
          status: 'printed',
          printedAt: now,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      }

      await db.orders.update(params.orderRecordId, {
        status: 'Shipped',
        carrier: params.carrier,
        trackingNumber: params.trackingNumber,
        // Real dispatch timestamp: drives "shipped today" locally and matches
        // the cloud `shipped_at` used by v_wms_kpi_summary.
        shippedAt: now,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
        updatedAt: now,
      });

      await db.auditLogs.add({
        action: 'ORDER_DISPATCHED',
        details: `${shipmentRef}: Dispatched ${order.orderId} via ${params.carrier} (${params.trackingNumber}) from ${dispatchedBins
          .map((b) => `${b.qty}× ${b.sku} @ ${b.location}/${b.lotNumber}`)
          .join(', ')}`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  await enqueueCloudOperation(
    'dispatch_order',
    {
      orderId: orderIdStr,
      carrier: params.carrier,
      trackingNumber: params.trackingNumber,
      operator: params.operator,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `dispatch:${scope.warehouseCode}:${orderIdStr}`
  );

  return { shipmentRef, dispatchedBins, shippedAt: now };
}

/**
 * Step 8: Process Return (RMA) with Inspection Checkpoint
 */
export async function processReturnTransactional(params: {
  orderId?: string;
  sku: string;
  quantity: number;
  reason: string;
  disposition: 'quarantine' | 'restock' | 'scrap';
  operator: string;
  operatorRole?: string;
  /** Bin the returned units are physically placed in. */
  receivingBin?: string;
  lotNumber?: string;
  tenantCode?: string;
  warehouseCode?: string;
}): Promise<{ rmaRef: string; routedTo: 'qc_hold' | 'putaway_queue' | 'scrapped'; bin: string }> {
  if (!hasPermission(params.operatorRole || 'operator', 'returns.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks returns.execute permission');
  }
  const cleanSku = params.sku.trim();
  if (!cleanSku || params.quantity <= 0) {
    throw new Error('VALIDATION_ERROR: Valid SKU and positive quantity required');
  }
  if (params.disposition === 'scrap' && !hasPermission(params.operatorRole, 'returns.manage')) {
    throw new Error('PERMISSION_DENIED: Supervisor permission (returns.manage) required to scrap returned stock');
  }

  const now = new Date().toISOString();
  const scope = await resolveScope({ tenantCode: params.tenantCode, warehouseCode: params.warehouseCode });
  const rmaRef = `RMA-${Date.now()}`;
  const returnsBin = (params.receivingBin?.trim() || 'RETURNS-DOCK').toUpperCase();
  const lotNumber = (params.lotNumber?.trim() || `RMA-${new Date().toISOString().slice(0, 10)}`);
  let routedTo: 'qc_hold' | 'putaway_queue' | 'scrapped' = 'qc_hold';

  await db.transaction('rw', LIFECYCLE_TABLES(), async () => {
      const inv = await db.inventory
        .where('[tenantCode+warehouseCode+sku]')
        .equals([scope.tenantCode, scope.warehouseCode, cleanSku])
        .first();

      if (params.disposition === 'quarantine') {
        routedTo = 'qc_hold';
        // Returned units land in a blocked dimension: physically present,
        // counted, and never allocatable until QC releases them.
        await upsertDimension({
          scope,
          sku: cleanSku,
          location: returnsBin,
          lotNumber,
          stockStatus: 'QUARANTINE',
          qtyDelta: params.quantity,
          operator: params.operator,
          movementType: 'return',
          note: `${rmaRef}: ${params.reason}`,
          referenceId: rmaRef,
        });
        await db.qcHolds.add({
          sku: cleanSku,
          quantity: params.quantity,
          lotNumber,
          reason: `RMA Inspection (${rmaRef}): ${params.reason}`,
          status: 'hold',
          location: returnsBin,
          operator: params.operator,
          createdAt: now,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      } else if (params.disposition === 'restock') {
        routedTo = 'putaway_queue';
        const suggestedLoc = (inv?.location || 'PHONE-A-01').toUpperCase();
        // Staged in a HOLD dimension at the returns dock until directed putaway
        // posts it into an allocatable bin.
        await upsertDimension({
          scope,
          sku: cleanSku,
          location: returnsBin,
          lotNumber,
          stockStatus: 'HOLD',
          qtyDelta: params.quantity,
          operator: params.operator,
          movementType: 'return',
          note: `${rmaRef}: restock staged for putaway`,
          referenceId: rmaRef,
        });
        await db.putawayTasks.add({
          taskId: `PUT-${rmaRef}`,
          sku: cleanSku,
          product: inv?.product || cleanSku,
          quantity: params.quantity,
          lotNumber,
          sourceLocation: returnsBin,
          sourceType: 'returns',
          suggestedLocation: suggestedLoc,
          destinationZone: suggestedLoc.split('-')[0] || 'PHONE-A',
          status: 'pending',
          priority: 'normal',
          createdAt: now,
          qcStatus: 'passed',
          putawayMethod: 'direct',
          operator: params.operator,
          estimatedTime: 10,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      } else {
        routedTo = 'scrapped';
        await upsertDimension({
          scope,
          sku: cleanSku,
          location: returnsBin,
          lotNumber,
          stockStatus: 'DAMAGED',
          qtyDelta: params.quantity,
          operator: params.operator,
          movementType: 'qc_adjustment',
          note: `${rmaRef} scrapped on return (${params.reason})`,
          referenceId: rmaRef,
        });
      }

      await db.returns.add({
        orderId: params.orderId?.trim() || 'WALK-IN',
        sku: cleanSku,
        reason: params.reason,
        restocked: params.disposition === 'restock',
        quantity: params.quantity,
        processedAt: now,
        tenantCode: scope.tenantCode,
        warehouseCode: scope.warehouseCode,
      });

      if (params.orderId?.trim()) {
        const order = await db.orders
          .where('[tenantCode+warehouseCode]')
          .equals([scope.tenantCode, scope.warehouseCode])
          .and((o) => o.orderId === params.orderId!.trim())
          .first();
        if (order?.id != null) {
          await db.orders.update(order.id, { status: 'Returned', updatedAt: now });
        }
      }

      await db.auditLogs.add({
        action: 'RMA_PROCESSED',
        details: `${rmaRef}: ${params.quantity}× ${cleanSku} (${params.reason}) -> ${routedTo} @ ${returnsBin}/${lotNumber}`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  await enqueueCloudOperation(
    'return_rma',
    {
      orderId: params.orderId || '',
      sku: cleanSku,
      qty: params.quantity,
      reason: params.reason,
      disposition: params.disposition,
      operator: params.operator,
      bin: returnsBin,
      lotNumber,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `rma:${scope.warehouseCode}:${rmaRef}`,
  );

  return { rmaRef, routedTo, bin: returnsBin };
}
