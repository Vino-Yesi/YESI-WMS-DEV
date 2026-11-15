import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  db,
  availableQty,
  DEFAULT_TENANT_CODE,
  DEFAULT_WAREHOUSE_CODE,
  type StockBalance,
  type InventoryReservation,
} from '@/lib/db';
import {
  fefoCompare,
  pickSequenceOf,
  dimensionKey,
  allocatableDimensions,
  planFefoAllocation,
  commitAllocationPlan,
  upsertDimension,
  transferDimension,
  verifyPickScan,
  refreshInventoryRollup,
  skuAvailability,
  expireStaleReservations,
  type StockScope,
  type DimensionAvailability,
} from '@/lib/stockBalances';

const SCOPE: StockScope = { tenantCode: DEFAULT_TENANT_CODE, warehouseCode: DEFAULT_WAREHOUSE_CODE };
const OTHER_WH: StockScope = { tenantCode: DEFAULT_TENANT_CODE, warehouseCode: 'SHJ-HUB2' };

function iso(daysFromNow: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function dim(over: Partial<DimensionAvailability> = {}): DimensionAvailability {
  return {
    balanceId: 1,
    location: 'PHONE-A-01-01',
    sku: 'SKU-X',
    lotNumber: 'LOT-1',
    stockStatus: 'AVAILABLE',
    expiryDate: null,
    onHandQty: 10,
    reservedQty: 0,
    quarantineQty: 0,
    locallyReserved: 0,
    available: 10,
    ...over,
  };
}

/** Wipes every operational table so each test starts from a known warehouse. */
async function resetWarehouse() {
  await Promise.all([
    db.stockBalances.clear(),
    db.inventoryReservations.clear(),
    db.inventory.clear(),
    db.inventoryMovements.clear(),
    db.serialNumbers.clear(),
    db.auditLogs.clear(),
  ]);
}

async function seedBalance(over: Partial<StockBalance> = {}): Promise<number> {
  return db.stockBalances.add({
    tenantCode: SCOPE.tenantCode,
    warehouseCode: SCOPE.warehouseCode,
    location: 'PHONE-A-01-01',
    sku: 'SKU-X',
    lotNumber: 'LOT-1',
    stockStatus: 'AVAILABLE',
    onHandQty: 10,
    reservedQty: 0,
    quarantineQty: 0,
    expiryDate: null,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...over,
  } as StockBalance);
}

beforeEach(async () => {
  await db.open();
  await resetWarehouse();
});

describe('FEFO ordering primitives', () => {
  it('ranks the soonest usable expiry first and open-dated stock last', () => {
    const soon = dim({ expiryDate: iso(5) });
    const later = dim({ expiryDate: iso(30) });
    const open = dim({ expiryDate: null });

    expect([open, later, soon].sort(fefoCompare).map((d) => d.expiryDate)).toEqual([
      iso(5),
      iso(30),
      null,
    ]);
  });

  it('breaks expiry ties on the bin walk path, and only then on bin depth', () => {
    const expiry = iso(10);
    const a1 = dim({ location: 'PHONE-A-01-01', expiryDate: expiry, available: 2 });
    const a9b = dim({ location: 'PHONE-A-09-02', expiryDate: expiry, available: 2 });
    const a9c = dim({ location: 'PHONE-A-09-03', expiryDate: expiry, available: 40 });

    // Same expiry → the walk path decides, even when an earlier bin holds less.
    expect([a9c, a9b, a1].sort(fefoCompare).map((d) => d.location)).toEqual([
      'PHONE-A-01-01',
      'PHONE-A-09-02',
      'PHONE-A-09-03',
    ]);

    // Identical expiry AND identical pick sequence → drain the deepest bin first.
    const north = dim({ location: 'PHONE-A-09-02-NORTH', expiryDate: expiry, available: 2 });
    const south = dim({ location: 'PHONE-A-09-02-SOUTH', expiryDate: expiry, available: 40 });
    expect(pickSequenceOf(north.location)).toBe(pickSequenceOf(south.location));
    expect([north, south].sort(fefoCompare).map((d) => d.location)).toEqual([
      'PHONE-A-09-02-SOUTH',
      'PHONE-A-09-02-NORTH',
    ]);
  });

  it('derives a monotonic pick sequence from a bin code', () => {
    expect(pickSequenceOf('PHONE-A-01-01')).toBeLessThan(pickSequenceOf('PHONE-A-09-01'));
    expect(pickSequenceOf('phone-a-01-01')).toBe(pickSequenceOf('PHONE-A-01-01'));
    expect(pickSequenceOf('')).toBe(0);
  });

  it('keys a dimension on bin + lot + status + serial so rows can never merge wrongly', () => {
    expect(dimensionKey('A-01', 'LOT-1')).toBe('A-01|LOT-1|AVAILABLE|');
    expect(dimensionKey('A-01', 'LOT-1', 'QUARANTINE')).not.toBe(dimensionKey('A-01', 'LOT-1'));
    expect(dimensionKey('A-01', 'LOT-1', 'AVAILABLE', 'SN-9')).not.toBe(dimensionKey('A-01', 'LOT-1'));
  });
});

describe('allocatableDimensions: what may actually be promised', () => {
  it('hides quarantine, damaged, hold and expired rows entirely', async () => {
    await seedBalance({ location: 'Q-01', stockStatus: 'QUARANTINE', quarantineQty: 10 });
    await seedBalance({ location: 'D-01', stockStatus: 'DAMAGED' });
    await seedBalance({ location: 'H-01', stockStatus: 'HOLD' });
    await seedBalance({ location: 'E-01', expiryDate: iso(-2) });
    await seedBalance({ location: 'OK-01', onHandQty: 7 });

    const rows = await allocatableDimensions('SKU-X', SCOPE);
    expect(rows.map((r) => r.location)).toEqual(['OK-01']);
    expect(rows[0].available).toBe(7);
  });

  it('subtracts both server reservations and quarantine holds from on-hand', async () => {
    await seedBalance({ onHandQty: 20, reservedQty: 5, quarantineQty: 3 });
    const rows = await allocatableDimensions('SKU-X', SCOPE);
    expect(rows[0].available).toBe(12);
    expect(availableQty({ onHandQty: 20, reservedQty: 5, quarantineQty: 3 })).toBe(12);
  });

  it('never counts units another order already promised, but does count its own', async () => {
    await seedBalance({ location: 'A-01', onHandQty: 10 });
    const base: Omit<InventoryReservation, 'reservationId'> = {
      orderId: 'ORD-1',
      sku: 'SKU-X',
      quantity: 4,
      location: 'A-01',
      lotNumber: 'LOT-1',
      stockStatus: 'AVAILABLE',
      status: 'reserved',
      fefoPriority: 1,
      reservedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operator: 'tester',
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
    };
    await db.inventoryReservations.add({ ...base, reservationId: 'RES-ORD-1' } as InventoryReservation);

    expect((await allocatableDimensions('SKU-X', SCOPE))[0].available).toBe(6);
    // Re-planning the same order must see its own promise as free again.
    expect((await allocatableDimensions('SKU-X', SCOPE, 'ORD-1'))[0].available).toBe(10);
  });

  it('charges unscoped legacy reservations against the deepest bin, not the FEFO front', async () => {
    await seedBalance({ location: 'A-01', expiryDate: iso(3), onHandQty: 5 });
    await seedBalance({ location: 'Z-99', expiryDate: iso(60), onHandQty: 5 });
    await db.inventoryReservations.add({
      reservationId: 'RES-LEGACY',
      orderId: 'ORD-OLD',
      sku: 'SKU-X',
      quantity: 5,
      status: 'reserved',
      fefoPriority: 1,
      reservedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operator: 'legacy',
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
    } as InventoryReservation);

    const rows = await allocatableDimensions('SKU-X', SCOPE);
    // The FEFO front stays clean; the fully promised bin is dropped from the
    // allocatable list rather than being reported as a zero-availability pick.
    expect(rows.map((r) => r.location)).toEqual(['A-01']);
    expect(rows[0].available).toBe(5);
    expect(rows[0].locallyReserved).toBe(0);
  });

  it('never crosses into another warehouse', async () => {
    await seedBalance({ warehouseCode: OTHER_WH.warehouseCode, location: 'SHJ-01', onHandQty: 50 });
    expect(await allocatableDimensions('SKU-X', SCOPE)).toEqual([]);
    expect((await allocatableDimensions('SKU-X', OTHER_WH))[0].available).toBe(50);
  });
});

describe('planFefoAllocation: multi-bin walk and all-or-nothing shortfall', () => {
  beforeEach(async () => {
    await seedBalance({ location: 'A-01', expiryDate: iso(4), onHandQty: 3 });
    await seedBalance({ location: 'A-02', expiryDate: iso(9), onHandQty: 4 });
    await seedBalance({ location: 'A-03', expiryDate: null, onHandQty: 100 });
  });

  it('is a pure plan: nothing is reserved by planning alone', async () => {
    const plan = await planFefoAllocation('SKU-X', 6, SCOPE);
    expect(plan.shortfall).toBe(0);
    expect(plan.picks.map((p) => `${p.location}:${p.qty}`)).toEqual(['A-01:3', 'A-02:3']);

    const balances = await db.stockBalances.toArray();
    expect(balances.every((b) => b.reservedQty === 0)).toBe(true);
    expect(await db.inventoryReservations.count()).toBe(0);
  });

  it('walks bins in expiry order and only takes what each bin holds', async () => {
    const plan = await planFefoAllocation('SKU-X', 20, SCOPE);
    expect(plan.picks.map((p) => p.location)).toEqual(['A-01', 'A-02', 'A-03']);
    expect(plan.picks.map((p) => p.qty)).toEqual([3, 4, 13]);
    expect(plan.picks.reduce((s, p) => s + p.qty, 0)).toBe(20);
  });

  it('reports an exact shortfall when the warehouse cannot cover the order', async () => {
    const plan = await planFefoAllocation('SKU-X', 500, SCOPE);
    expect(plan.shortfall).toBe(500 - 107);
    expect(plan.picks.reduce((s, p) => s + p.qty, 0)).toBe(107);
  });

  it('plans zero picks for a SKU that does not exist in this warehouse', async () => {
    const plan = await planFefoAllocation('SKU-GHOST', 5, SCOPE);
    expect(plan.picks).toEqual([]);
    expect(plan.shortfall).toBe(5);
  });
});

describe('commitAllocationPlan: exact-dimension reservation writes', () => {
  it('raises reserved_qty only on the planned dimensions and pins each reservation to a bin', async () => {
    const near = await seedBalance({ location: 'A-01', expiryDate: iso(4), onHandQty: 3 });
    const mid = await seedBalance({ location: 'A-02', expiryDate: iso(9), onHandQty: 4 });
    await seedBalance({ location: 'A-03', onHandQty: 100 });

    const plan = await planFefoAllocation('SKU-X', 6, SCOPE);
    const reservations = await commitAllocationPlan(plan, {
      orderId: 'ORD-77',
      operator: 'tester',
      scope: SCOPE,
    });

    expect(reservations.map((r) => `${r.location}:${r.qty}`)).toEqual(['A-01:3', 'A-02:3']);
    expect((await db.stockBalances.get(near))?.reservedQty).toBe(3);
    expect((await db.stockBalances.get(mid))?.reservedQty).toBe(3);

    const rows = await db.inventoryReservations.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orderId === 'ORD-77' && r.status === 'allocated')).toBe(true);
    expect(rows.every((r) => r.stockStatus === 'AVAILABLE')).toBe(true);
    expect(rows.every((r) => r.fefoPriority === pickSequenceOf(r.location!))).toBe(true);
    expect(rows.every((r) => r.tenantCode === SCOPE.tenantCode && r.warehouseCode === SCOPE.warehouseCode)).toBe(true);
    // Reserving must not silently destroy availability for the untouched bin.
    expect((await allocatableDimensions('SKU-X', SCOPE)).find((d) => d.location === 'A-03')?.available).toBe(100);
  });

  it('refuses to commit when a dimension was drained between plan and commit', async () => {
    const id = await seedBalance({ location: 'A-01', onHandQty: 5 });
    const plan = await planFefoAllocation('SKU-X', 5, SCOPE);

    // A concurrent pick removes the stock before the commit lands.
    await db.stockBalances.update(id, { onHandQty: 1 });

    await expect(
      commitAllocationPlan(plan, { orderId: 'ORD-RACE', operator: 'tester', scope: SCOPE }),
    ).rejects.toThrow(/ALLOCATION_CONFLICT/);
  });

  it('rejects a commit against a dimension that no longer exists', async () => {
    const plan = await planFefoAllocation('SKU-X', 1, SCOPE);
    await seedBalance({ location: 'A-01', onHandQty: 5 });
    const real = await planFefoAllocation('SKU-X', 1, SCOPE);
    await db.stockBalances.clear();

    await expect(
      commitAllocationPlan(real.picks.length ? real : plan, { orderId: 'ORD-GONE', operator: 'tester', scope: SCOPE }),
    ).rejects.toThrow(/BALANCE_MISSING|ALLOCATION_CONFLICT/);
  });
});

describe('upsertDimension: the only legal way to move local stock', () => {
  it('creates a dimension on first receipt and merges into it afterwards', async () => {
    const first = await upsertDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      location: 'A-01',
      lotNumber: 'LOT-1',
      qtyDelta: 10,
      operator: 'tester',
      movementType: 'inbound',
    });
    expect(first.created).toBe(true);
    expect(first.onHandQty).toBe(10);

    const second = await upsertDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      location: 'a-01', // bin codes are case-insensitive
      lotNumber: 'LOT-1',
      qtyDelta: 5,
      operator: 'tester',
    });
    expect(second.created).toBe(false);
    expect(second.balanceId).toBe(first.balanceId);
    expect(second.onHandQty).toBe(15);
    expect(await db.stockBalances.count()).toBe(1);
  });

  it('keeps a different lot of the same SKU in the same bin as its own row', async () => {
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-1', qtyDelta: 4, operator: 't' });
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-2', qtyDelta: 6, operator: 't' });
    expect(await db.stockBalances.count()).toBe(2);
  });

  it('refuses a post with no bin, a zero delta or a non-numeric delta', async () => {
    await expect(
      upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: '  ', lotNumber: 'LOT-1', qtyDelta: 5, operator: 't' }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(
      upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-1', qtyDelta: 0, operator: 't' }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(
      upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-1', qtyDelta: NaN, operator: 't' }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('refuses to roll a bin below what is already reserved', async () => {
    const id = await seedBalance({ location: 'A-01', onHandQty: 10, reservedQty: 8 });
    await expect(
      upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-1', qtyDelta: -5, operator: 't' }),
    ).rejects.toThrow(/reserved|INSUFFICIENT|ROLLBACK/i);
    expect((await db.stockBalances.get(id))?.onHandQty).toBe(10);
  });

  it('marks quarantine rows as fully blocked so they can never be allocated', async () => {
    await upsertDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      location: 'QC-01',
      lotNumber: 'LOT-1',
      qtyDelta: 6,
      stockStatus: 'QUARANTINE',
      operator: 't',
      movementType: 'qc_adjustment',
    });
    const row = (await db.stockBalances.toArray())[0];
    expect(row.quarantineQty).toBe(6);
    expect(availableQty(row)).toBe(0);
    expect(await allocatableDimensions('SKU-X', SCOPE)).toEqual([]);
  });

  it('writes an immutable ledger row carrying the exact dimension and idempotency key', async () => {
    await upsertDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      location: 'A-01',
      lotNumber: 'LOT-1',
      qtyDelta: 3,
      operator: 'auditor',
      movementType: 'inbound',
      referenceId: 'GRN-1',
      note: 'test receipt',
    });
    const ledger = await db.inventoryMovements.toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      sku: 'SKU-X',
      quantity: 3,
      type: 'inbound',
      toLocation: 'A-01',
      lotNumber: 'LOT-1',
      warehouseCode: SCOPE.warehouseCode,
      tenantCode: SCOPE.tenantCode,
      operator: 'auditor',
    });
    expect(ledger[0].idempotencyKey).toBeTruthy();
  });

  it('bumps the optimistic-concurrency version on every write', async () => {
    const { balanceId } = await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'L', qtyDelta: 5, operator: 't' });
    const v1 = (await db.stockBalances.get(balanceId))!.version;
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'L', qtyDelta: 1, operator: 't' });
    expect((await db.stockBalances.get(balanceId))!.version).toBeGreaterThan(v1);
  });
});

describe('transferDimension: atomic bin/status moves', () => {
  it('moves units out of one bin into another in a single balanced step', async () => {
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'RECV-DOCK-01', lotNumber: 'LOT-1', qtyDelta: 10, operator: 't' });
    await transferDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      qty: 4,
      from: { location: 'RECV-DOCK-01', lotNumber: 'LOT-1' },
      to: { location: 'PHONE-A-05-02', lotNumber: 'LOT-1' },
      operator: 't',
    });

    const byBin = new Map((await db.stockBalances.toArray()).map((b) => [b.location, b.onHandQty]));
    expect(byBin.get('RECV-DOCK-01')).toBe(6);
    expect(byBin.get('PHONE-A-05-02')).toBe(4);
  });

  it('moves blocked stock into quarantine without making it allocatable', async () => {
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'LOT-1', qtyDelta: 10, operator: 't' });
    await transferDimension({
      scope: SCOPE,
      sku: 'SKU-X',
      qty: 3,
      from: { location: 'A-01', lotNumber: 'LOT-1' },
      to: { location: 'QC-HOLD-01', lotNumber: 'LOT-1', stockStatus: 'QUARANTINE' },
      operator: 'supervisor',
    });

    const rows = await allocatableDimensions('SKU-X', SCOPE);
    expect(rows.map((r) => r.location)).toEqual(['A-01']);
    expect(rows[0].available).toBe(7);
    const held = (await db.stockBalances.toArray()).find((b) => b.stockStatus === 'QUARANTINE')!;
    expect(held.onHandQty).toBe(3);
    expect(availableQty(held)).toBe(0);
  });

  it('refuses to move more than the source bin holds and refuses non-positive quantities', async () => {
    await upsertDimension({ scope: SCOPE, sku: 'SKU-X', location: 'A-01', lotNumber: 'L', qtyDelta: 2, operator: 't' });
    await expect(
      transferDimension({
        scope: SCOPE,
        sku: 'SKU-X',
        qty: 5,
        from: { location: 'A-01', lotNumber: 'L' },
        to: { location: 'B-01', lotNumber: 'L' },
        operator: 't',
      }),
    ).rejects.toThrow();
    await expect(
      transferDimension({
        scope: SCOPE,
        sku: 'SKU-X',
        qty: 0,
        from: { location: 'A-01', lotNumber: 'L' },
        to: { location: 'B-01', lotNumber: 'L' },
        operator: 't',
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    // The failed transfer must not have created the destination row.
    expect((await db.stockBalances.toArray()).map((b) => b.location)).toEqual(['A-01']);
  });
});

describe('verifyPickScan: proof the operator stood at the right bin', () => {
  beforeEach(async () => {
    await seedBalance({ location: 'A-01', lotNumber: 'LOT-1', onHandQty: 5 });
    await db.inventory.add({
      sku: 'SKU-X',
      product: 'Test phone',
      barcode: '8801234567890',
      rfidTag: 'RFID-SKU-X',
      location: 'A-01',
      lotNumber: 'LOT-1',
      stock: 5,
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
      updatedAt: new Date().toISOString(),
    } as never);
  });

  it('accepts a registered SKU barcode and RFID tag', async () => {
    expect(await verifyPickScan({ sku: 'SKU-X', scannedCode: '8801234567890', scope: SCOPE })).toEqual({ ok: true, matched: 'barcode' });
    expect(await verifyPickScan({ sku: 'SKU-X', scannedCode: 'RFID-SKU-X', scope: SCOPE })).toEqual({ ok: true, matched: 'barcode' });
  });

  it('accepts the lot label as a scan target', async () => {
    expect(
      await verifyPickScan({ sku: 'SKU-X', scannedCode: 'lot-1', lotNumber: 'LOT-1', location: 'A-01', scope: SCOPE }),
    ).toEqual({ ok: true, matched: 'lot' });
  });

  it('accepts a serial number stored in that exact bin', async () => {
    await db.serialNumbers.add({
      serialNumber: 'SN-0001',
      sku: 'SKU-X',
      product: 'Test phone',
      status: 'in_stock',
      location: 'A-01',
      operator: 't',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
    } as never);
    expect(
      await verifyPickScan({ sku: 'SKU-X', scannedCode: 'SN-0001', location: 'A-01', scope: SCOPE }),
    ).toEqual({ ok: true, matched: 'serial' });
  });

  it('rejects an empty scan with SCAN_REQUIRED', async () => {
    const res = await verifyPickScan({ sku: 'SKU-X', scannedCode: '   ', scope: SCOPE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('SCAN_REQUIRED');
  });

  it('rejects a serial that belongs to another SKU or another bin', async () => {
    await db.serialNumbers.add({
      serialNumber: 'SN-OTHER',
      sku: 'SKU-Y',
      product: 'Other',
      status: 'in_stock',
      location: 'B-02',
      operator: 't',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const wrongSku = await verifyPickScan({ sku: 'SKU-X', scannedCode: 'SN-OTHER', scope: SCOPE });
    expect(wrongSku.ok).toBe(false);
    if (!wrongSku.ok) expect(wrongSku.code).toBe('PICK_SCAN_MISMATCH');

    await db.serialNumbers.add({
      serialNumber: 'SN-FAR',
      sku: 'SKU-X',
      product: 'Test phone',
      status: 'in_stock',
      location: 'Z-99',
      operator: 't',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    const wrongBin = await verifyPickScan({ sku: 'SKU-X', scannedCode: 'SN-FAR', location: 'A-01', scope: SCOPE });
    expect(wrongBin.ok).toBe(false);
    if (!wrongBin.ok) expect(wrongBin.code).toBe('PICK_SCAN_MISMATCH');
  });

  it('rejects an arbitrary code that matches nothing', async () => {
    const res = await verifyPickScan({ sku: 'SKU-X', scannedCode: 'BANANA', location: 'A-01', scope: SCOPE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('PICK_SCAN_MISMATCH');
  });
});

describe('refreshInventoryRollup: the SKU view is derived, never authoritative', () => {
  it('aggregates on-hand, sellable, reserved, blocked, bins, lots and earliest expiry', async () => {
    await seedBalance({ location: 'A-01', lotNumber: 'LOT-1', expiryDate: iso(20), onHandQty: 10, reservedQty: 2 });
    await seedBalance({ location: 'A-02', lotNumber: 'LOT-2', expiryDate: iso(5), onHandQty: 6 });
    await seedBalance({ location: 'QC-01', lotNumber: 'LOT-1', stockStatus: 'QUARANTINE', onHandQty: 4, quarantineQty: 4 });

    await refreshInventoryRollup('SKU-X', SCOPE);
    const row = (await db.inventory.toArray())[0];

    expect(row.stock).toBe(20);
    expect(row.reservedStock).toBe(2);
    expect(row.quarantineStock).toBe(4);
    // 10 on hand − 2 reserved, plus 6 clean units; quarantine is never sellable.
    expect(row.availableStock).toBe(14);
    expect(row.binCount).toBe(3);
    expect(row.lotNumbers?.sort()).toEqual(['LOT-1', 'LOT-2']);
    expect(row.earliestExpiry).toBe(iso(5));
    // The headline location is the FEFO front: the bin that ships next.
    expect(row.location).toBe('A-02');
  });

  it('feeds skuAvailability with the same numbers the rollup shows', async () => {
    await seedBalance({ location: 'A-01', lotNumber: 'LOT-1', onHandQty: 8, reservedQty: 3 });
    await seedBalance({ location: 'Q-01', stockStatus: 'QUARANTINE', lotNumber: 'LOT-1', onHandQty: 2, quarantineQty: 2 });

    const summary = await skuAvailability('SKU-X', SCOPE);
    expect(summary).toMatchObject({ onHand: 10, reserved: 3, quarantine: 2, available: 5, dimensions: 1 });
    expect(summary.bins).toEqual(['A-01', 'Q-01']);
  });

  it('reports zero availability rather than a stale positive number when the warehouse is empty', async () => {
    const summary = await skuAvailability('SKU-EMPTY', SCOPE);
    expect(summary).toMatchObject({ onHand: 0, available: 0, dimensions: 0 });
    expect(summary.bins).toEqual([]);
  });
});

describe('expireStaleReservations: promises must not outlive their window', () => {
  it('releases expired reservations so their units become sellable again', async () => {
    await seedBalance({ location: 'A-01', onHandQty: 10 });
    await db.inventoryReservations.add({
      reservationId: 'RES-STALE',
      orderId: 'ORD-STALE',
      sku: 'SKU-X',
      quantity: 6,
      location: 'A-01',
      lotNumber: 'LOT-1',
      stockStatus: 'AVAILABLE',
      status: 'reserved',
      fefoPriority: 1,
      reservedAt: new Date(Date.now() - 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      operator: 't',
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
    } as InventoryReservation);

    expect((await allocatableDimensions('SKU-X', SCOPE))[0].available).toBe(4);
    const expired = await expireStaleReservations(SCOPE);
    expect(expired).toBe(1);
    expect((await allocatableDimensions('SKU-X', SCOPE))[0].available).toBe(10);
    expect((await db.inventoryReservations.where('reservationId').equals('RES-STALE').first())?.status).toBe('expired');
  });

  it('leaves live reservations untouched', async () => {
    await seedBalance({ location: 'A-01', onHandQty: 10 });
    await db.inventoryReservations.add({
      reservationId: 'RES-LIVE',
      orderId: 'ORD-LIVE',
      sku: 'SKU-X',
      quantity: 6,
      location: 'A-01',
      lotNumber: 'LOT-1',
      stockStatus: 'AVAILABLE',
      status: 'reserved',
      fefoPriority: 1,
      reservedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operator: 't',
      tenantCode: SCOPE.tenantCode,
      warehouseCode: SCOPE.warehouseCode,
    } as InventoryReservation);

    expect(await expireStaleReservations(SCOPE)).toBe(0);
    expect((await allocatableDimensions('SKU-X', SCOPE))[0].available).toBe(4);
  });
});
