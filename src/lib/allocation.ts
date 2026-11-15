/**
 * YESI-WMS Offline FEFO Allocation Engine (v3)
 *
 * All-or-nothing, multi-bin, dimension-accurate reservation.
 *
 * Guarantees:
 *  1. Stock is reserved from the EXACT bins/lots FEFO selects — an order that
 *     needs 6 units split across three bins produces three reservations, each
 *     pointing at the bin the picker must walk to.
 *  2. Availability is computed per dimension as `on_hand - reserved -
 *     quarantine - locally promised`, so two orders can never be promised the
 *     same physical unit, and quarantine/damaged stock is never allocatable.
 *  3. Expired lots are excluded from FEFO entirely (mirrors the server-side
 *     `expiry_date >= CURRENT_DATE` guard).
 *  4. If any line shortfalls, NOTHING is committed: the whole order stays
 *     Pending and the conflict is reported with per-SKU detail.
 *  5. Warehouse scoping is strict — a switch of active warehouse can never
 *     reserve or consume another site's stock.
 */

import { db, logAction, type InventoryReservation, type Order } from './db';
import { enqueueCloudOperation, getActiveWarehouseCode } from './supabaseSync';
import {
  allocatableDimensions,
  commitAllocationPlan,
  consumeReservationUnits,
  getStockScope,
  planFefoAllocation,
  releaseReservationUnits,
  skuAvailability,
  verifyPickScan,
  type AllocationLine,
  type StockScope,
} from './stockBalances';

export type { InventoryReservation };
export { allocatableDimensions, skuAvailability, verifyPickScan };

export interface AllocationResult {
  success: boolean;
  reservations: InventoryReservation[];
  conflicts: string[];
  message: string;
  /** Per-SKU FEFO plan, including shortfalls, for the picker UI. */
  plan: AllocationLine[];
  warehouseCode: string;
}

const TX_TABLES = () => [
  db.stockBalances,
  db.inventory,
  db.inventoryReservations,
  db.serialNumbers,
  db.orders,
  db.auditLogs,
  db.inventoryMovements,
];

function countLines(requiredSkus: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const raw of String(requiredSkus ?? '').split(',')) {
    const sku = raw.trim();
    if (!sku) continue;
    // `SKU*3` and `SKU:3` are accepted explicit quantity notations.
    const m = sku.match(/^(.*?)[*x:](\d+)$/i);
    if (m && m[1]) {
      counts[m[1].trim()] = (counts[m[1].trim()] || 0) + Number(m[2]);
    } else {
      counts[sku] = (counts[sku] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Atomic transactional FEFO allocation across every bin that holds the SKU.
 *
 * Wraps multi-SKU reservation inside a single Dexie `rw` transaction. If ANY
 * line lacks sufficient unreserved available stock, zero partial reservations
 * are committed (all-or-nothing atomicity).
 */
export async function allocateOrder(order: Order, operator: string, explicitWarehouse?: string): Promise<AllocationResult> {
  const scope: StockScope = {
    tenantCode: (order.tenantCode ?? '').trim().toUpperCase() || (await getStockScope()).tenantCode,
    warehouseCode:
      explicitWarehouse?.trim().toUpperCase() ||
      (order.warehouseCode ?? '').trim().toUpperCase() ||
      (await getActiveWarehouseCode()),
  };

  const counts = countLines(order.requiredSkus);
  const plan: AllocationLine[] = [];
  const conflicts: string[] = [];
  const reservations: InventoryReservation[] = [];

  if (Object.keys(counts).length === 0) {
    return {
      success: false,
      reservations,
      conflicts: ['Order has no SKU lines'],
      message: 'Allocation failed: order has no SKU lines',
      plan,
      warehouseCode: scope.warehouseCode,
    };
  }

  await db.transaction('rw', TX_TABLES(), async () => {
    // Phase 1 — plan every line before mutating anything.
    for (const [sku, qty] of Object.entries(counts)) {
      const line = await planFefoAllocation(sku, qty, scope, order.orderId);
      plan.push(line);

      if (line.shortfall > 0) {
        const avail = await skuAvailability(sku, scope, order.orderId);
        const dims = await allocatableDimensions(sku, scope, order.orderId);
        if (dims.length === 0 && avail.onHand > 0) {
          conflicts.push(
            `${sku}: ${avail.onHand} on hand but none allocatable (reserved ${avail.reserved}, quarantine ${avail.quarantine}, or lot expired)`,
          );
        } else {
          conflicts.push(
            `${sku}: need ${qty}, only ${avail.available} available across ${dims.length} bin(s) [${dims
              .map((d) => `${d.location}/${d.lotNumber}=${d.available}`)
              .join(', ') || 'no bins'}]`,
          );
        }
      }
    }

    if (conflicts.length > 0) {
      await db.auditLogs.add({
        action: 'ALLOCATION_CONFLICT',
        details: `FEFO allocation shortfall for ${order.orderId}: ${conflicts.join('; ')}`,
        operator,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Phase 2 — commit reservations dimension by dimension.
    for (const line of plan) {
      const created = await commitAllocationPlan(line, { orderId: order.orderId, operator, scope });
      for (const c of created) {
        reservations.push({
          reservationId: c.reservationId,
          orderId: order.orderId,
          sku: line.sku,
          quantity: c.qty,
          location: c.location,
          lotNumber: c.lotNumber,
          status: 'allocated',
          fefoPriority: 0,
          reservedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
          operator,
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        });
      }
    }

    if (order.id != null && order.status === 'Pending') {
      await db.orders.update(order.id, { status: 'Picking', updatedAt: new Date().toISOString() });
    }
  });

  const success = conflicts.length === 0;
  if (success) {
    await logAction(
      'ALLOCATE_ORDER',
      `Reserved inventory for ${order.orderId} in ${scope.warehouseCode}: ${reservations
        .map((r) => `${r.quantity}× ${r.sku} @ ${r.location}/${r.lotNumber}`)
        .join(', ')}`,
      operator,
    );
    void enqueueCloudOperation(
      'allocate_order',
      { orderId: order.orderId, operator, tenantCode: scope.tenantCode, warehouseCode: scope.warehouseCode },
      `alloc:${scope.warehouseCode}:${order.orderId}`,
    );
  }

  return {
    success,
    reservations,
    conflicts,
    plan,
    warehouseCode: scope.warehouseCode,
    message: success
      ? `Allocated ${reservations.length} bin line(s) for ${order.orderId} in ${scope.warehouseCode}`
      : `Allocation failed: ${conflicts.join('; ')}`,
  };
}

/**
 * Scan-verified pick confirmation.
 *
 * The scanned code MUST match the reserved dimension (serial, SKU barcode or
 * lot label). A mismatch throws `PICK_SCAN_MISMATCH` and consumes nothing, so a
 * wrong-bin grab can never be recorded as a completed pick.
 */
export async function confirmPickWithScan(params: {
  reservationId: string;
  scannedCode: string;
  pickedQty?: number;
  operator: string;
}): Promise<{ ok: true; consumed: number; location: string; lotNumber: string; matched: 'serial' | 'barcode' | 'lot' } | { ok: false; code: string; error: string }> {
  const scope = await getStockScope();
  const reservation = await db.inventoryReservations.where('reservationId').equals(params.reservationId).first();
  if (!reservation) return { ok: false, code: 'RESERVATION_NOT_FOUND', error: `Unknown reservation ${params.reservationId}` };
  if (reservation.status === 'picked' || reservation.status === 'released') {
    return { ok: false, code: 'ALREADY_CONFIRMED', error: `Reservation ${params.reservationId} is already ${reservation.status}` };
  }

  const scan = await verifyPickScan({
    sku: reservation.sku,
    scannedCode: params.scannedCode,
    location: reservation.location,
    lotNumber: reservation.lotNumber,
    scope: { tenantCode: reservation.tenantCode ?? scope.tenantCode, warehouseCode: reservation.warehouseCode ?? scope.warehouseCode },
  });
  if (!scan.ok) {
    await db.auditLogs
      .add({
        action: 'PICK_SCAN_MISMATCH',
        details: `${params.operator} scanned "${params.scannedCode}" against ${reservation.sku} @ ${reservation.location ?? 'unscoped'}: ${scan.error}`,
        operator: params.operator,
        timestamp: new Date().toISOString(),
      })
      .catch(() => {});
    return scan;
  }

  let result: { consumed: number; location: string; lotNumber: string } | null = null;
  let failure: { code: string; error: string } | null = null;

  await db.transaction('rw', TX_TABLES(), async () => {
    try {
      result = await consumeReservationUnits(reservation, {
        operator: params.operator,
        qty: params.pickedQty,
        movementType: 'pick',
        note: `Scan-verified pick (${scan.matched}: ${params.scannedCode})`,
        scope,
      });
    } catch (err) {
      failure = { code: 'CONSUME_FAILED', error: err instanceof Error ? err.message : String(err) };
      throw err; // rolls the Dexie transaction back
    }
  });

  if (failure || !result) return failure ?? { ok: false, code: 'CONSUME_FAILED', error: 'Pick could not be committed' };
  const consumed = result as { consumed: number; location: string; lotNumber: string };

  await logAction(
    'PICK_CONFIRMED',
    `${consumed.consumed}× ${reservation.sku} picked from ${consumed.location}/${consumed.lotNumber} for ${reservation.orderId} (scan ${scan.matched})`,
    params.operator,
  );
  void enqueueCloudOperation(
    'confirm_pick',
    {
      taskNumber: params.reservationId,
      scannedCode: params.scannedCode,
      pickedQty: consumed.consumed,
      operator: params.operator,
      orderId: reservation.orderId,
      tenantCode: scope.tenantCode,
      warehouseCode: scope.warehouseCode,
    },
    `pick:${scope.warehouseCode}:${params.reservationId}:${params.scannedCode}`,
  ).catch(() => {});

  return { ok: true, ...consumed, matched: scan.matched };
}

export async function releaseReservation(reservationId: string, operator: string): Promise<boolean> {
  const scope = await getStockScope();
  let released = false;

  await db.transaction('rw', TX_TABLES(), async () => {
    const res = await db.inventoryReservations.where('reservationId').equals(reservationId).first();
    if (!res || res.status === 'picked' || res.status === 'released') return;

    if (res.serialNumbers) {
      for (const sn of res.serialNumbers.split(',')) {
        const serial = await db.serialNumbers.where('serialNumber').equals(sn.trim()).first();
        if (serial?.id != null) {
          await db.serialNumbers.update(serial.id, {
            status: 'in_stock',
            orderId: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    released = await releaseReservationUnits(res, scope);
  });

  if (released) await logAction('RELEASE_RESERVATION', `Released ${reservationId}`, operator);
  return released;
}

/** Fulfils (ships out) a reservation against its exact reserved dimension. */
export async function fulfillReservation(reservationId: string, operator: string): Promise<boolean> {
  const scope = await getStockScope();
  let done = false;

  await db.transaction('rw', TX_TABLES(), async () => {
    const res = await db.inventoryReservations.where('reservationId').equals(reservationId).first();
    if (!res || (res.status !== 'reserved' && res.status !== 'allocated')) return;

    await consumeReservationUnits(res, {
      operator,
      movementType: 'pick',
      note: `FEFO allocation ${reservationId}`,
      scope,
    });

    if (res.serialNumbers) {
      for (const sn of res.serialNumbers.split(',')) {
        const serial = await db.serialNumbers.where('serialNumber').equals(sn.trim()).first();
        if (serial?.id != null) {
          await db.serialNumbers.update(serial.id, {
            status: 'shipped',
            orderId: res.orderId,
            shippedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    done = true;
  });

  return done;
}

/** Active reservations for one warehouse, grouped by SKU. */
export async function getAllocationSummary(explicitWarehouse?: string) {
  const scope = await getStockScope(explicitWarehouse);

  const [reservations, orders, balances] = await Promise.all([
    db.inventoryReservations.where('[tenantCode+warehouseCode]').equals([scope.tenantCode, scope.warehouseCode]).toArray(),
    db.orders.where('[tenantCode+warehouseCode+status]').equals([scope.tenantCode, scope.warehouseCode, 'Pending']).toArray(),
    db.stockBalances.where('[tenantCode+warehouseCode]').equals([scope.tenantCode, scope.warehouseCode]).toArray(),
  ]);

  const active = reservations.filter((r) => r.status === 'reserved' || r.status === 'allocated');
  const reservedBySku: Record<string, number> = {};
  for (const r of active) reservedBySku[r.sku] = (reservedBySku[r.sku] || 0) + r.quantity;

  const allocatedOrderIds = new Set(active.map((r) => r.orderId));
  const pendingAllocations = orders.filter((o) => !allocatedOrderIds.has(o.orderId)).length;

  const onHandBySku = new Map<string, number>();
  const availableBySku = new Map<string, number>();
  const binsBySku = new Map<string, Set<string>>();
  const expiryBySku = new Map<string, string>();
  for (const b of balances) {
    onHandBySku.set(b.sku, (onHandBySku.get(b.sku) ?? 0) + b.onHandQty);
    if (b.stockStatus === 'AVAILABLE') {
      availableBySku.set(b.sku, (availableBySku.get(b.sku) ?? 0) + Math.max(0, b.onHandQty - b.reservedQty - b.quarantineQty));
      binsBySku.set(b.sku, (binsBySku.get(b.sku) ?? new Set<string>()).add(b.location));
      if (b.expiryDate) {
        const prev = expiryBySku.get(b.sku);
        if (!prev || b.expiryDate < prev) expiryBySku.set(b.sku, b.expiryDate);
      }
    }
  }

  let conflicts = 0;
  for (const o of orders) {
    for (const [sku, needed] of Object.entries(countLines(o.requiredSkus))) {
      const free = (availableBySku.get(sku) ?? 0) - (reservedBySku[sku] ?? 0);
      if (free < needed) {
        conflicts++;
        break;
      }
    }
  }

  const topReserved = Object.entries(reservedBySku)
    .map(([sku, reserved]) => ({
      sku,
      reserved,
      available: Math.max(0, (availableBySku.get(sku) ?? 0) - reserved),
      bins: binsBySku.get(sku)?.size ?? 0,
    }))
    .sort((a, b) => b.reserved - a.reserved)
    .slice(0, 5);

  return {
    warehouseCode: scope.warehouseCode,
    activeReservations: active.length,
    totalReservations: active.length,
    totalReservedUnits: active.reduce((s, r) => s + r.quantity, 0),
    pendingAllocations,
    conflicts,
    multiBinSkus: Array.from(binsBySku.entries()).filter(([, bins]) => bins.size > 1).length,
    fefoEligible: expiryBySku.size,
    earliestExpiry: Array.from(expiryBySku.values()).sort()[0] ?? null,
    topReserved,
  };
}

export async function autoAllocatePendingOrders(operator: string, explicitWarehouse?: string): Promise<{ allocated: number; failed: number; conflicts: string[] }> {
  const scope = await getStockScope(explicitWarehouse);
  const orders = await db.orders
    .where('[tenantCode+warehouseCode+status]')
    .equals([scope.tenantCode, scope.warehouseCode, 'Pending'])
    .toArray();
  const existing = await db.inventoryReservations
    .where('[tenantCode+warehouseCode]')
    .equals([scope.tenantCode, scope.warehouseCode])
    .toArray();
  const allocatedIds = new Set(existing.filter((r) => r.status === 'reserved' || r.status === 'allocated').map((r) => r.orderId));

  let allocated = 0;
  let failed = 0;
  const conflicts: string[] = [];

  const sorted = [...orders]
    .filter((o) => !allocatedIds.has(o.orderId))
    .sort((a, b) => {
      const prio = { urgent: 0, high: 1, normal: 2 } as Record<string, number>;
      return (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2) || a.createdAt.localeCompare(b.createdAt);
    });

  for (const order of sorted) {
    const result = await allocateOrder(order, operator, scope.warehouseCode);
    if (result.success) allocated++;
    else {
      failed++;
      conflicts.push(...result.conflicts.map((c) => `${order.orderId}: ${c}`));
    }
  }

  return { allocated, failed, conflicts };
}
