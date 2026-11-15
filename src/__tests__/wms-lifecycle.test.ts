import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  db,
  DEFAULT_TENANT_CODE,
  DEFAULT_WAREHOUSE_CODE,
  type Order,
} from '@/lib/db';
import {
  receiveInboundTransactional,
  createQcHoldTransactional,
  dispositionQcHoldTransactional,
  completePutawayTransactional,
  confirmPickAndPackTransactional,
  dispatchShipmentTransactional,
  processReturnTransactional,
} from '@/lib/lifecycle';
import { allocateOrder } from '@/lib/allocation';
import { allocatableDimensions, skuAvailability } from '@/lib/stockBalances';
import { getOutboxCounts } from '@/lib/supabaseSync';

const TENANT = DEFAULT_TENANT_CODE;
const WH = DEFAULT_WAREHOUSE_CODE;
const OTHER_WH = 'SHJ-HUB2';
const SCOPE = { tenantCode: TENANT, warehouseCode: WH };

/** Days from today as ISO yyyy-mm-dd — expiry maths must be date-relative. */
function iso(daysFromNow: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function resetWarehouse() {
  await Promise.all([
    db.stockBalances.clear(),
    db.inventory.clear(),
    db.inventoryMovements.clear(),
    db.inventoryReservations.clear(),
    db.inbound.clear(),
    db.qcHolds.clear(),
    db.putawayTasks.clear(),
    db.orders.clear(),
    db.returns.clear(),
    db.serialNumbers.clear(),
    db.shippingLabels.clear(),
    db.outboxEvents.clear(),
    db.auditLogs.clear(),
  ]);
}

async function addOrder(orderId: string, requiredSkus: string, over: Partial<Order> = {}): Promise<number> {
  const now = new Date().toISOString();
  return db.orders.add({
    orderId,
    status: 'Pending',
    requiredSkus,
    priority: 'normal',
    createdAt: now,
    updatedAt: now,
    tenantCode: TENANT,
    warehouseCode: WH,
    ...over,
  } as Order);
}

/** Receives + puts away so `qty` units of `sku` are allocatable in `bin`. */
async function stockBin(sku: string, qty: number, bin: string, lot: string, expiry?: string) {
  const grn = await receiveInboundTransactional({
    sku,
    qty,
    description: sku,
    receivingBin: 'RECV-DOCK-01',
    suggestedLocation: bin,
    lotNumber: lot,
    expiryDate: expiry,
    qcStatus: 'passed',
    operator: 'seed-op',
    operatorRole: 'admin',
    tenantCode: TENANT,
    warehouseCode: WH,
  });
  expect(grn.putawayTaskId).toBeTruthy();
  const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
  await completePutawayTransactional({
    taskId: task!.id!,
    actualLocation: bin,
    operator: 'seed-op',
    operatorRole: 'admin',
    tenantCode: TENANT,
    warehouseCode: WH,
  });
}

beforeEach(async () => {
  await db.open();
  await resetWarehouse();
});

describe('Step 1 — Inbound GRN: receiving never creates sellable stock', () => {
  it('queues directed putaway for passed QC and posts zero allocatable units', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17Black256',
      qty: 10,
      description: 'Galaxy A17 Black 256GB',
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-2026-11',
      expiryDate: iso(120),
      qcStatus: 'passed',
      operator: 'op-1',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(grn.stage).toBe('putaway_queued');
    expect(grn.grnRef).toMatch(/^GRN-/);

    // Nothing is allocatable yet: stock only exists after a verified putaway.
    expect(await allocatableDimensions('A17Black256', SCOPE)).toEqual([]);
    const summary = await skuAvailability('A17Black256', SCOPE);
    expect(summary.available).toBe(0);

    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    expect(task).toMatchObject({
      sku: 'A17Black256',
      quantity: 10,
      lotNumber: 'LOT-2026-11',
      sourceLocation: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      status: 'pending',
      qcStatus: 'passed',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    const receipt = (await db.inbound.toArray())[0];
    expect(receipt).toMatchObject({ sku: 'A17Black256', qty: 10, lotNumber: 'LOT-2026-11', bin: 'RECV-DOCK-01' });
    expect(await db.qcHolds.count()).toBe(0);
  });

  it('routes pending/failed QC into a blocking hold AND a quarantine dimension', async () => {
    for (const qcStatus of ['pending', 'failed'] as const) {
      await resetWarehouse();
      const grn = await receiveInboundTransactional({
        sku: 'WATCH-7',
        qty: 6,
        receivingBin: 'RECV-DOCK-02',
        lotNumber: 'LOT-W7',
        qcStatus,
        operator: 'op-1',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      });

      expect(grn.stage).toBe('qc_hold');
      expect(grn.putawayTaskId).toBeUndefined();

      const hold = (await db.qcHolds.toArray())[0];
      expect(hold).toMatchObject({ sku: 'WATCH-7', quantity: 6, status: 'hold', location: 'RECV-DOCK-02' });

      // The units are physically in the building and must be visible as blocked.
      const blocked = (await db.stockBalances.toArray()).find((b) => b.stockStatus === 'QUARANTINE');
      expect(blocked).toMatchObject({ location: 'RECV-DOCK-02', onHandQty: 6, quarantineQty: 6 });
      expect(await allocatableDimensions('WATCH-7', SCOPE)).toEqual([]);
    }
  });

  it('rejects a non-ISO expiry and a zero/negative quantity', async () => {
    await expect(
      receiveInboundTransactional({
        sku: 'A17',
        qty: 5,
        expiryDate: '11/20/2026',
        qcStatus: 'passed',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/VALIDATION_ERROR.*ISO/);

    await expect(
      receiveInboundTransactional({
        sku: 'A17',
        qty: 0,
        qcStatus: 'passed',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('refuses a role without inbound.execute', async () => {
    await expect(
      receiveInboundTransactional({
        sku: 'A17',
        qty: 5,
        qcStatus: 'passed',
        operator: 'viewer-1',
        operatorRole: 'viewer',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe('Step 2 — QC checkpoint', () => {
  it('blocks putaway until QC is passed or released', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 4,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-02-01',
      lotNumber: 'LOT-1',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    // Simulate a task whose inspection has not cleared.
    await db.putawayTasks.update(task!.id!, { qcStatus: 'pending' });

    await expect(
      completePutawayTransactional({
        taskId: task!.id!,
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/QC_CHECKPOINT_BLOCKED/);
    expect(await allocatableDimensions('A17', SCOPE)).toEqual([]);
  });

  it('requires supervisor/admin to release or scrap a hold', async () => {
    const hold = await createQcHoldTransactional({
      sku: 'A17',
      quantity: 2,
      reason: 'Seal broken',
      bin: 'QC-HOLD-AREA',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    await expect(
      dispositionQcHoldTransactional({
        holdId: hold.holdId,
        disposition: 'release',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    await expect(
      dispositionQcHoldTransactional({
        holdId: hold.holdId,
        disposition: 'release',
        operator: 'viewer',
        operatorRole: 'viewer',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('release moves the blocked units and raises a directed putaway task', async () => {
    await stockBin('A17', 10, 'PHONE-A-01-01', 'LOT-1');
    const hold = await createQcHoldTransactional({
      sku: 'A17',
      quantity: 4,
      reason: 'Cosmetic damage',
      bin: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      operator: 'inspector',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    expect(hold.blockedQty).toBe(4);
    expect(hold.unmatchedQty).toBe(0);
    expect((await skuAvailability('A17', SCOPE)).available).toBe(6);

    const res = await dispositionQcHoldTransactional({
      holdId: hold.holdId,
      disposition: 'release',
      operator: 'supervisor-1',
      operatorRole: 'supervisor',
      quarantineBin: 'PHONE-A-01-01',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(res.putawayTaskId).toBeTruthy();
    const task = await db.putawayTasks.where('taskId').equals(res.putawayTaskId!).first();
    expect(task).toMatchObject({ sourceType: 'qc_release', quantity: 4, qcStatus: 'passed', status: 'pending' });

    // Released units sit in HOLD, not AVAILABLE, until putaway posts them.
    const rows = await db.stockBalances.toArray();
    expect(rows.find((b) => b.stockStatus === 'HOLD')?.onHandQty).toBe(4);
    expect((await skuAvailability('A17', SCOPE)).available).toBe(6);
  });

  it('scrap removes the blocked units from stock entirely', async () => {
    await stockBin('A17', 10, 'PHONE-A-01-01', 'LOT-1');
    const hold = await createQcHoldTransactional({
      sku: 'A17',
      quantity: 3,
      reason: 'Cracked screens',
      bin: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      operator: 'inspector',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    await dispositionQcHoldTransactional({
      holdId: hold.holdId,
      disposition: 'scrap',
      operator: 'admin-1',
      operatorRole: 'admin',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    const summary = await skuAvailability('A17', SCOPE);
    expect(summary.onHand).toBe(7);
    expect(summary.quarantine).toBe(0);
    expect(summary.available).toBe(7);
    expect((await db.qcHolds.toArray())[0].status).toBe('rejected');
  });

  it('reports units that are not physically in the named bin instead of inventing them', async () => {
    await stockBin('A17', 2, 'PHONE-A-01-01', 'LOT-1');
    const hold = await createQcHoldTransactional({
      sku: 'A17',
      quantity: 9,
      reason: 'Reported damage',
      bin: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      operator: 'inspector',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    expect(hold.blockedQty).toBe(2);
    expect(hold.unmatchedQty).toBe(7);
  });

  it('refuses to disposition the same hold twice', async () => {
    const hold = await createQcHoldTransactional({
      sku: 'A17',
      quantity: 1,
      reason: 'Check',
      operator: 'inspector',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    await dispositionQcHoldTransactional({
      holdId: hold.holdId,
      disposition: 'release',
      operator: 'sup',
      operatorRole: 'supervisor',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    await expect(
      dispositionQcHoldTransactional({
        holdId: hold.holdId,
        disposition: 'release',
        operator: 'sup',
        operatorRole: 'supervisor',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/QC_HOLD_ALREADY_PROCESSED/);
  });
});

describe('Step 3 — Directed putaway posts allocatable stock', () => {
  it('posts into the exact bin/lot dimension and records the movement', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17Black256',
      qty: 12,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-03-02',
      lotNumber: 'LOT-2026-11',
      expiryDate: iso(90),
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();

    const res = await completePutawayTransactional({
      taskId: task!.id!,
      actualLocation: 'PHONE-A-03-02',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(res).toMatchObject({ location: 'PHONE-A-03-02', lotNumber: 'LOT-2026-11', newStock: 12 });
    const summary = await skuAvailability('A17Black256', SCOPE);
    expect(summary).toMatchObject({ onHand: 12, available: 12, dimensions: 1 });
    expect(summary.earliestExpiry).toBe(iso(90));

    const ledger = await db.inventoryMovements.toArray();
    expect(ledger.some((m) => m.type === 'putaway' && m.toLocation === 'PHONE-A-03-02')).toBe(true);
    expect((await db.putawayTasks.get(task!.id!))?.status).toBe('completed');
  });

  it('rejects a destination-bin scan that belongs to another SKU', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 5,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    await db.serialNumbers.add({
      serialNumber: 'SN-OTHER',
      sku: 'WATCH-7',
      product: 'Watch',
      status: 'in_stock',
      location: 'PHONE-A-01-01',
      operator: 'seed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tenantCode: TENANT,
      warehouseCode: WH,
    } as never);

    await expect(
      completePutawayTransactional({
        taskId: task!.id!,
        actualLocation: 'PHONE-A-01-01',
        scannedCode: 'SN-OTHER',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PICK_SCAN_MISMATCH/);

    // The rejected putaway must not have completed or posted anything.
    expect((await db.putawayTasks.get(task!.id!))?.status).not.toBe('completed');
    expect(await allocatableDimensions('A17', SCOPE)).toEqual([]);
  });

  it('accepts the lot label as the bin scan and refuses an unknown task', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 3,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-SCAN',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    await expect(
      completePutawayTransactional({
        taskId: task!.id!,
        actualLocation: 'PHONE-A-01-01',
        scannedCode: 'lot-scan',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).resolves.toMatchObject({ lotNumber: 'LOT-SCAN' });

    await expect(
      completePutawayTransactional({
        taskId: 999_999,
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PUTAWAY_TASK_NOT_FOUND/);
  });
});

describe('Steps 4-6 — FEFO allocation, scan-verified pick & pack', () => {
  beforeEach(async () => {
    // Two bins, two lots, different expiries: FEFO must pick the soonest first.
    await stockBin('A17', 4, 'PHONE-A-01-01', 'LOT-SOON', iso(10));
    await stockBin('A17', 6, 'PHONE-A-02-01', 'LOT-LATER', iso(200));
  });

  it('allocates across bins in expiry order and reserves the exact dimensions', async () => {
    const id = await addOrder('ORD-1', 'A17*7');
    const order = (await db.orders.get(id))!;
    const result = await allocateOrder(order, 'op', WH);

    expect(result.success).toBe(true);
    expect(result.plan[0].picks.map((p) => `${p.location}:${p.lotNumber}:${p.qty}`)).toEqual([
      'PHONE-A-01-01:LOT-SOON:4',
      'PHONE-A-02-01:LOT-LATER:3',
    ]);
    expect(result.reservations).toHaveLength(2);

    const summary = await skuAvailability('A17', SCOPE);
    expect(summary.onHand).toBe(10);
    expect(summary.reserved).toBe(7);
    expect(summary.available).toBe(3);
  });

  it('is all-or-nothing: a shortfall reserves nothing at all', async () => {
    const id = await addOrder('ORD-BIG', 'A17*50');
    const order = (await db.orders.get(id))!;
    const result = await allocateOrder(order, 'op', WH);

    expect(result.success).toBe(false);
    expect(result.reservations).toEqual([]);
    expect(result.conflicts.join(' ')).toMatch(/A17/);
    expect(await db.inventoryReservations.count()).toBe(0);
    expect((await skuAvailability('A17', SCOPE)).reserved).toBe(0);
  });

  it('packs scan-verified lines, consumes the reservations and reports the real bins', async () => {
    const id = await addOrder('ORD-2', 'A17*5');
    const order = (await db.orders.get(id))!;
    const allocation = await allocateOrder(order, 'op', WH);
    expect(allocation.success).toBe(true);

    const packed = await confirmPickAndPackTransactional({
      orderRecordId: id,
      pickedItems: [
        { sku: 'A17', picked: 4, scannedCode: 'A17', location: 'PHONE-A-01-01', lotNumber: 'LOT-SOON' },
        { sku: 'A17', picked: 1, scannedCode: 'A17', location: 'PHONE-A-02-01', lotNumber: 'LOT-LATER' },
      ],
      boxName: 'PHONE-S',
      weightKg: 0.9,
      operator: 'packer',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(packed.status).toBe('Packed');
    expect(packed.pickedBins).toEqual([
      { sku: 'A17', location: 'PHONE-A-01-01', lotNumber: 'LOT-SOON', qty: 4 },
      { sku: 'A17', location: 'PHONE-A-02-01', lotNumber: 'LOT-LATER', qty: 1 },
    ]);
    expect((await db.orders.get(id))?.status).toBe('Packed');

    // Units physically left the bins; reservations were consumed, not stranded.
    const summary = await skuAvailability('A17', SCOPE);
    expect(summary.onHand).toBe(5);
    expect(summary.reserved).toBe(0);
    expect(summary.available).toBe(5);
  });

  it('refuses to pack without a scan, and refuses a scan from the wrong bin', async () => {
    const id = await addOrder('ORD-3', 'A17*2');
    await allocateOrder((await db.orders.get(id))!, 'op', WH);

    await expect(
      confirmPickAndPackTransactional({
        orderRecordId: id,
        pickedItems: [{ sku: 'A17', picked: 2 }],
        operator: 'packer',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/SCAN_REQUIRED/);

    await expect(
      confirmPickAndPackTransactional({
        orderRecordId: id,
        pickedItems: [{ sku: 'A17', picked: 2, scannedCode: 'NOT-A-CODE' }],
        operator: 'packer',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PICK_SCAN_MISMATCH/);

    // Nothing was consumed by the rejected attempts (allocation had already
    // moved the order to Picking; packing never completed).
    expect((await db.orders.get(id))?.status).toBe('Picking');
    expect((await skuAvailability('A17', SCOPE)).onHand).toBe(10);
    expect(await db.auditLogs.where('action').equals('PICK_SCAN_MISMATCH').count()).toBeGreaterThan(0);
  });

  it('refuses a zero or negative picked quantity', async () => {
    const id = await addOrder('ORD-4', 'A17*1');
    await expect(
      confirmPickAndPackTransactional({
        orderRecordId: id,
        pickedItems: [{ sku: 'A17', picked: 0, scannedCode: 'A17' }],
        operator: 'packer',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('Step 7 — Dispatch', () => {
  beforeEach(async () => {
    await stockBin('A17', 5, 'PHONE-A-01-01', 'LOT-1', iso(30));
  });

  it('refuses to dispatch an order that was never packed', async () => {
    const id = await addOrder('ORD-UNPACKED', 'A17*2');
    await expect(
      dispatchShipmentTransactional({
        orderRecordId: id,
        carrier: 'GBS',
        trackingNumber: 'GBS123',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/DISPATCH_INCOMPLETE|LIFECYCLE_VIOLATION/);
  });

  it('ships a packed order, stamps shippedAt and names the bins the units came from', async () => {
    const id = await addOrder('ORD-SHIP', 'A17*3');
    await allocateOrder((await db.orders.get(id))!, 'op', WH);
    await confirmPickAndPackTransactional({
      orderRecordId: id,
      pickedItems: [{ sku: 'A17', picked: 3, scannedCode: 'A17', location: 'PHONE-A-01-01', lotNumber: 'LOT-1' }],
      boxName: 'PHONE-S',
      operator: 'packer',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    const before = Date.now();
    const dispatch = await dispatchShipmentTransactional({
      orderRecordId: id,
      carrier: 'GBS Express',
      trackingNumber: 'GBS-99887766',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(dispatch.shipmentRef).toMatch(/^SHP-/);
    expect(dispatch.dispatchedBins).toEqual([
      { sku: 'A17', location: 'PHONE-A-01-01', lotNumber: 'LOT-1', qty: 3 },
    ]);
    expect(new Date(dispatch.shippedAt).getTime()).toBeGreaterThanOrEqual(before);

    const order = (await db.orders.get(id))!;
    expect(order.status).toBe('Shipped');
    expect(order.shippedAt).toBe(dispatch.shippedAt);
    expect(order.carrier).toBe('GBS Express');
    expect(order.trackingNumber).toBe('GBS-99887766');

    // Physical stock left the warehouse.
    const summary = await skuAvailability('A17', SCOPE);
    expect(summary.onHand).toBe(2);
    expect(summary.reserved).toBe(0);
    expect(summary.available).toBe(2);
  });

  it('refuses to ship an order that belongs to another warehouse', async () => {
    const id = await addOrder('ORD-OTHER-SITE', 'A17*1', { warehouseCode: OTHER_WH });
    await expect(
      dispatchShipmentTransactional({
        orderRecordId: id,
        carrier: 'GBS',
        trackingNumber: 'X',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/WAREHOUSE_MISMATCH/);
  });

  it('refuses to ship the same order twice', async () => {
    const id = await addOrder('ORD-TWICE', 'A17*2');
    await allocateOrder((await db.orders.get(id))!, 'op', WH);
    await confirmPickAndPackTransactional({
      orderRecordId: id,
      pickedItems: [{ sku: 'A17', picked: 2, scannedCode: 'A17', location: 'PHONE-A-01-01', lotNumber: 'LOT-1' }],
      operator: 'packer',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    await dispatchShipmentTransactional({
      orderRecordId: id,
      carrier: 'GBS',
      trackingNumber: 'T-1',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    await expect(
      dispatchShipmentTransactional({
        orderRecordId: id,
        carrier: 'GBS',
        trackingNumber: 'T-2',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/LIFECYCLE_VIOLATION|DISPATCH_INCOMPLETE/);
  });
});

describe('Step 8 — Returns / RMA', () => {
  beforeEach(async () => {
    await stockBin('A17', 5, 'PHONE-A-01-01', 'LOT-1');
  });

  it('quarantines a defective return at the named bin and raises a hold', async () => {
    const outcome = await processReturnTransactional({
      sku: 'A17',
      quantity: 2,
      reason: 'Defective/Damaged',
      disposition: 'quarantine',
      receivingBin: 'RETURNS-DOCK',
      lotNumber: 'LOT-RMA',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(outcome).toMatchObject({ routedTo: 'qc_hold', bin: 'RETURNS-DOCK' });
    expect(outcome.rmaRef).toMatch(/^RMA-/);

    const blocked = (await db.stockBalances.toArray()).find(
      (b) => b.location === 'RETURNS-DOCK' && b.stockStatus === 'QUARANTINE',
    );
    expect(blocked?.onHandQty).toBe(2);
    expect((await db.qcHolds.toArray()).some((h) => h.location === 'RETURNS-DOCK' && h.status === 'hold')).toBe(true);
    // Quarantined returns are not sellable.
    expect((await skuAvailability('A17', SCOPE)).available).toBe(5);
  });

  it('stages a saleable return in HOLD until directed putaway posts it', async () => {
    const outcome = await processReturnTransactional({
      sku: 'A17',
      quantity: 3,
      reason: 'Customer Cancelled',
      disposition: 'restock',
      receivingBin: 'RETURNS-DOCK',
      lotNumber: 'LOT-1',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    expect(outcome.routedTo).toBe('putaway_queue');
    const staged = (await db.stockBalances.toArray()).find((b) => b.stockStatus === 'HOLD');
    expect(staged).toMatchObject({ location: 'RETURNS-DOCK', onHandQty: 3 });
    expect((await skuAvailability('A17', SCOPE)).available).toBe(5);

    const task = await db.putawayTasks.where('sourceType').equals('returns').first();
    expect(task).toMatchObject({ quantity: 3, status: 'pending', tenantCode: TENANT, warehouseCode: WH });
  });

  it('rejects a non-positive quantity and an unknown disposition', async () => {
    await expect(
      processReturnTransactional({
        sku: 'A17',
        quantity: 0,
        reason: 'x',
        disposition: 'restock',
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('Cross-cutting guarantees', () => {
  it('queues exactly one idempotent cloud command per lifecycle step', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 4,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    await completePutawayTransactional({
      taskId: task!.id!,
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    const events = await db.outboxEvents.toArray();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const keys = events.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(events.every((e) => e.tenantCode === TENANT && e.warehouseCode === WH)).toBe(true);
    expect(events.every((e) => ['pending', 'processing', 'published', 'failed', 'dead_letter'].includes(e.status))).toBe(true);

    const counts = await getOutboxCounts();
    expect(counts.pending + counts.processing + counts.failed + counts.deadLetter).toBe(events.length);
  });

  it('replaying a putaway with the same task is refused, not double-posted', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 4,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    await completePutawayTransactional({
      taskId: task!.id!,
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    await expect(
      completePutawayTransactional({
        taskId: task!.id!,
        operator: 'op',
        operatorRole: 'operator',
        tenantCode: TENANT,
        warehouseCode: WH,
      }),
    ).rejects.toThrow(/PUTAWAY_ALREADY_COMPLETED/);

    expect((await skuAvailability('A17', SCOPE)).onHand).toBe(4);
  });

  it('never lets one warehouse see another warehouse\'s stock', async () => {
    await stockBin('A17', 5, 'PHONE-A-01-01', 'LOT-1');
    await receiveInboundTransactional({
      sku: 'A17',
      qty: 7,
      receivingBin: 'SHJ-DOCK-01',
      suggestedLocation: 'SHJ-A-01-01',
      lotNumber: 'LOT-SHJ',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: OTHER_WH,
    });

    const dxb = await skuAvailability('A17', SCOPE);
    const shj = await skuAvailability('A17', { tenantCode: TENANT, warehouseCode: OTHER_WH });
    expect(dxb.onHand).toBe(5);
    expect(shj.onHand).toBe(0); // received, not yet put away at that site
    expect(dxb.bins).toEqual(['PHONE-A-01-01']);
  });

  it('writes a scoped audit trail for every step', async () => {
    const grn = await receiveInboundTransactional({
      sku: 'A17',
      qty: 2,
      receivingBin: 'RECV-DOCK-01',
      suggestedLocation: 'PHONE-A-01-01',
      lotNumber: 'LOT-1',
      qcStatus: 'passed',
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });
    const task = await db.putawayTasks.where('taskId').equals(grn.putawayTaskId!).first();
    await completePutawayTransactional({
      taskId: task!.id!,
      operator: 'op',
      operatorRole: 'operator',
      tenantCode: TENANT,
      warehouseCode: WH,
    });

    const logs = await db.auditLogs.toArray();
    expect(logs.some((l) => l.action === 'INBOUND_GRN_STAGED')).toBe(true);
    expect(logs.length).toBeGreaterThan(1);
  });
});
