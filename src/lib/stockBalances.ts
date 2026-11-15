/**
 * YESI-WMS Dimensional Stock Engine (v3)
 *
 * Single source of truth for offline/edge stock arithmetic.
 *
 * Rules enforced here mirror the authoritative Postgres functions added in
 * migration 008 (`wms_allocate_order_fefo`, `wms_confirm_pick_task`,
 * `wms_dispatch_order`) so an offline shift and a cloud-connected shift behave
 * identically:
 *
 *  1. Stock is addressed by its FULL physical dimension
 *     tenant → warehouse → bin → SKU → lot → stock status (→ serial).
 *     Quantities are never summed across bins, lots or statuses, and never
 *     across warehouses.
 *  2. FEFO candidate ordering is `expiry_date ASC NULLS LAST`, then pick
 *     sequence, then largest available quantity first — and expired lots are
 *     not allocatable at all.
 *  3. Availability is `on_hand - reserved - quarantine`, floored at zero, so a
 *     unit already promised to another order can never be promised twice.
 *  4. Every mutation is written to the immutable-style movement ledger
 *     (`inventoryMovements`) with the exact dimension it touched.
 */

import { db, availableQty, type StockBalance, type StockStatus } from './db';
import { DEFAULT_TENANT_CODE } from './db';

export interface StockScope {
  tenantCode: string;
  warehouseCode: string;
}

/** One physical dimension with its net availability after existing promises. */
export interface DimensionAvailability {
  balanceId: number;
  location: string;
  sku: string;
  lotNumber: string;
  stockStatus: StockStatus;
  serialNumber?: string;
  expiryDate: string | null;
  onHandQty: number;
  reservedQty: number;
  quarantineQty: number;
  /** Units already promised to other orders in the local reservation table. */
  locallyReserved: number;
  available: number;
}

export interface AllocationLine {
  sku: string;
  requiredQty: number;
  /** Dimensions chosen by FEFO, in pick order. */
  picks: Array<{
    balanceId: number;
    location: string;
    lotNumber: string;
    expiryDate: string | null;
    qty: number;
    serialNumber?: string;
  }>;
  shortfall: number;
}

const WAREHOUSE_PREF_KEY = 'wms_active_warehouse_code';

/** Resolves the active tenancy scope, honouring an explicit warehouse switch. */
export async function getStockScope(explicitWarehouse?: string): Promise<StockScope> {
  let warehouseCode = (explicitWarehouse ?? '').trim().toUpperCase();
  if (!warehouseCode) {
    try {
      const pref = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
      warehouseCode = (pref?.value ?? '').trim().toUpperCase();
    } catch {
      warehouseCode = '';
    }
  }
  return {
    tenantCode: DEFAULT_TENANT_CODE,
    warehouseCode: warehouseCode || 'DXB-FC1',
  };
}

/**
 * Deterministic pick sequence derived from the bin code itself
 * (aisle → rack → shelf → level), used as the FEFO tie-breaker exactly like
 * `wms_locations.pick_sequence` on the server.
 */
export function pickSequenceOf(location: string): number {
  const parts = String(location || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  let seq = 0;
  for (let i = 0; i < parts.length && i < 4; i++) {
    const numeric = Number(parts[i]);
    seq = seq * 1000 + (Number.isFinite(numeric) && parts[i] !== '' ? numeric : parts[i].charCodeAt(0));
  }
  return seq;
}

function isExpired(expiryDate: string | null | undefined, today = new Date()): boolean {
  if (!expiryDate) return false;
  const d = new Date(expiryDate);
  if (Number.isNaN(d.getTime())) return false;
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
  return d.getTime() < endOfToday.getTime();
}

/** FEFO ordering: soonest usable expiry, then pick sequence, then deepest bin. */
export function fefoCompare(a: DimensionAvailability, b: DimensionAvailability): number {
  const ea = a.expiryDate ?? '9999-12-31';
  const eb = b.expiryDate ?? '9999-12-31';
  if (ea !== eb) return ea < eb ? -1 : 1;
  const sa = pickSequenceOf(a.location);
  const sb = pickSequenceOf(b.location);
  if (sa !== sb) return sa - sb;
  if (a.available !== b.available) return b.available - a.available;
  return a.location.localeCompare(b.location);
}

/** All dimensions of a SKU inside one warehouse (never cross-warehouse). */
export async function listDimensions(sku: string, scope: StockScope): Promise<StockBalance[]> {
  return db.stockBalances
    .where('[tenantCode+warehouseCode+sku]')
    .equals([scope.tenantCode, scope.warehouseCode, sku])
    .toArray();
}

/**
 * Active promises for one SKU, grouped by the dimension they point at.
 *
 * Two independent records describe the same thing: the balance row's
 * `reserved_qty` (authoritative, and what a cloud snapshot materialises) and the
 * local reservation rows (the pick-list detail). Either one can lag the other —
 * a cloud pull can land before our own outbox drains, and a legacy row can
 * predate dimensional tracking. Summing them double-counts and collapses
 * availability to zero, so callers take the MAXIMUM of the two instead (see
 * `allocatableDimensions`).
 */
interface ReservationHolds {
  /** Every active promise per dimension key, all orders included. */
  byDimension: Map<string, number>;
  /** The re-planning order's own promises, which must be handed back to it. */
  ownByDimension: Map<string, number>;
  /** Legacy promises with no bin: cannot live in any dimension's reserved_qty. */
  unscoped: number;
  /** The re-planning order's share of those legacy promises. */
  unscopedOwn: number;
}

async function reservationHolds(
  sku: string,
  scope: StockScope,
  excludeOrderId?: string,
): Promise<ReservationHolds> {
  const rows = await db.inventoryReservations
    .where('[tenantCode+warehouseCode]')
    .equals([scope.tenantCode, scope.warehouseCode])
    .and((r) => r.sku === sku && (r.status === 'reserved' || r.status === 'allocated'))
    .toArray();

  const byDimension = new Map<string, number>();
  const ownByDimension = new Map<string, number>();
  let unscoped = 0;
  let unscopedOwn = 0;

  for (const r of rows) {
    const isOwn = Boolean(excludeOrderId) && r.orderId === excludeOrderId;
    if (!r.location) {
      if (isOwn) unscopedOwn += r.quantity;
      else unscoped += r.quantity;
      continue;
    }
    // Serial-less key: a reservation names a bin and lot, not an individual unit.
    const key = dimensionKey(r.location, r.lotNumber ?? 'DEFAULT');
    byDimension.set(key, (byDimension.get(key) ?? 0) + r.quantity);
    if (isOwn) ownByDimension.set(key, (ownByDimension.get(key) ?? 0) + r.quantity);
  }

  return { byDimension, ownByDimension, unscoped, unscopedOwn };
}

export function dimensionKey(location: string, lotNumber: string, stockStatus: StockStatus = 'AVAILABLE', serialNumber?: string): string {
  return [location, lotNumber, stockStatus, serialNumber ?? ''].join('|');
}

/**
 * Allocatable dimensions for a SKU in FEFO order.
 *
 * Excludes quarantine/damaged/hold rows and expired lots. The hold against each
 * dimension is `max(reserved_qty, active local promises)` — never their sum,
 * which would count the same promise twice — and an order that is re-planning
 * gets its own promise handed back so it can re-pick the same units.
 */
export async function allocatableDimensions(
  sku: string,
  scope: StockScope,
  excludeOrderId?: string,
): Promise<DimensionAvailability[]> {
  const balances = await listDimensions(sku, scope);
  const holds = await reservationHolds(sku, scope, excludeOrderId);
  let unscopedRemaining = Math.max(0, holds.unscoped - holds.unscopedOwn);

  const rows: DimensionAvailability[] = balances
    .filter((b) => b.stockStatus === 'AVAILABLE' && !isExpired(b.expiryDate))
    .map((b) => {
      const key = dimensionKey(b.location, b.lotNumber);
      const promised = holds.byDimension.get(key) ?? 0;
      const own = holds.ownByDimension.get(key) ?? 0;
      // Whichever record is ahead wins; the other is lagging, not additive.
      const effectiveReserved = Math.max(b.reservedQty, promised);
      const handedBack = Math.min(own, effectiveReserved);
      const sellable = Math.max(0, b.onHandQty - b.quarantineQty);
      return {
        balanceId: b.id as number,
        location: b.location,
        sku: b.sku,
        lotNumber: b.lotNumber,
        stockStatus: b.stockStatus,
        serialNumber: b.serialNumber,
        expiryDate: b.expiryDate ?? null,
        onHandQty: b.onHandQty,
        reservedQty: b.reservedQty,
        quarantineQty: b.quarantineQty,
        // Promises that the balance row does not yet reflect.
        locallyReserved: Math.max(0, effectiveReserved - b.reservedQty),
        available: Math.max(0, sellable - effectiveReserved + handedBack),
      };
    })
    .sort(fefoCompare);

  // Charge unscoped legacy reservations against the deepest bins last so the
  // FEFO front of the queue stays truthful.
  if (unscopedRemaining > 0) {
    for (let i = rows.length - 1; i >= 0 && unscopedRemaining > 0; i--) {
      const take = Math.min(rows[i].available, unscopedRemaining);
      rows[i].available -= take;
      rows[i].locallyReserved += take;
      unscopedRemaining -= take;
    }
  }

  return rows.filter((r) => r.available > 0);
}

/** Total availability of a SKU in one warehouse, split by status. */
export async function skuAvailability(sku: string, scope: StockScope, excludeOrderId?: string) {
  const balances = await listDimensions(sku, scope);
  const allocatable = await allocatableDimensions(sku, scope, excludeOrderId);
  const onHand = balances.reduce((s, b) => s + b.onHandQty, 0);
  const reserved = balances.reduce((s, b) => s + b.reservedQty, 0);
  const quarantine = balances.reduce((s, b) => s + b.quarantineQty, 0);
  return {
    sku,
    onHand,
    reserved,
    quarantine,
    available: allocatable.reduce((s, d) => s + d.available, 0),
    dimensions: allocatable.length,
    bins: Array.from(new Set(balances.map((b) => b.location))).sort(),
    lots: Array.from(new Set(balances.map((b) => b.lotNumber))).sort(),
    earliestExpiry: balances
      .map((b) => b.expiryDate)
      .filter((v): v is string => Boolean(v))
      .sort()[0] ?? null,
  };
}

/**
 * Plans a strict FEFO allocation across as many bins as needed.
 * Returns per-dimension picks and any shortfall; it does NOT mutate anything.
 */
export async function planFefoAllocation(
  sku: string,
  requiredQty: number,
  scope: StockScope,
  excludeOrderId?: string,
): Promise<AllocationLine> {
  const dimensions = await allocatableDimensions(sku, scope, excludeOrderId);
  const picks: AllocationLine['picks'] = [];
  let remaining = requiredQty;

  for (const d of dimensions) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, d.available);
    if (take <= 0) continue;
    picks.push({
      balanceId: d.balanceId,
      location: d.location,
      lotNumber: d.lotNumber,
      expiryDate: d.expiryDate,
      qty: take,
      serialNumber: d.serialNumber,
    });
    remaining -= take;
  }

  return { sku, requiredQty, picks, shortfall: remaining };
}

/**
 * Commits a planned allocation: raises `reserved_qty` on each exact dimension
 * and records one reservation row per (bin, lot) so the pick list tells the
 * operator precisely where to walk.
 *
 * MUST be called inside a Dexie `rw` transaction covering
 * `stockBalances`, `inventoryReservations`, `inventory`, `orders`, `auditLogs`.
 */
export async function commitAllocationPlan(
  line: AllocationLine,
  params: { orderId: string; operator: string; scope: StockScope; reservationPrefix?: string },
): Promise<Array<{ reservationId: string; location: string; lotNumber: string; qty: number }>> {
  const now = new Date().toISOString();
  const created: Array<{ reservationId: string; location: string; lotNumber: string; qty: number }> = [];

  for (const pick of line.picks) {
    const balance = await db.stockBalances.get(pick.balanceId);
    if (!balance) throw new Error(`BALANCE_MISSING: dimension ${pick.balanceId} disappeared mid-allocation`);
    const free = availableQty(balance);
    if (free < pick.qty) {
      throw new Error(
        `ALLOCATION_CONFLICT: ${line.sku} at ${balance.location}/${balance.lotNumber} has ${free} free but ${pick.qty} were planned`,
      );
    }

    await db.stockBalances.update(pick.balanceId, {
      reservedQty: balance.reservedQty + pick.qty,
      version: balance.version + 1,
      updatedAt: now,
    });

    const reservationId = `${params.reservationPrefix ?? 'RES'}-${params.orderId}-${pick.location}-${pick.lotNumber}-${Date.now().toString(36)}`;
    await db.inventoryReservations.add({
      reservationId,
      orderId: params.orderId,
      sku: line.sku,
      quantity: pick.qty,
      location: pick.location,
      lotNumber: pick.lotNumber,
      expiryDate: pick.expiryDate,
      serialNumbers: pick.serialNumber,
      stockStatus: 'AVAILABLE',
      status: 'allocated',
      fefoPriority: pickSequenceOf(pick.location),
      reservedAt: now,
      expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      operator: params.operator,
      tenantCode: params.scope.tenantCode,
      warehouseCode: params.scope.warehouseCode,
    });

    created.push({ reservationId, location: pick.location, lotNumber: pick.lotNumber, qty: pick.qty });
  }

  await refreshInventoryRollup(line.sku, params.scope);
  return created;
}

/**
 * Recomputes the derived per-SKU `inventory` rollup for one warehouse from the
 * dimensional balances. Keeps legacy screens working without letting them
 * become a second, divergent source of truth.
 */
export async function refreshInventoryRollup(sku: string, scope: StockScope): Promise<void> {
  const balances = await listDimensions(sku, scope);
  const now = new Date().toISOString();
  const existing = await db.inventory
    .where('[tenantCode+warehouseCode+sku]')
    .equals([scope.tenantCode, scope.warehouseCode, sku])
    .first();

  const onHand = balances.reduce((s, b) => s + b.onHandQty, 0);
  const reserved = balances.reduce((s, b) => s + b.reservedQty, 0);
  const quarantine = balances.reduce((s, b) => s + b.quarantineQty, 0);
  const allocatable = balances
    .filter((b) => b.stockStatus === 'AVAILABLE' && !isExpired(b.expiryDate))
    .sort((a, b) => (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999'));
  const primary = allocatable[0];

  const payload = {
    stock: onHand,
    reservedStock: reserved,
    quarantineStock: quarantine,
    availableStock: Math.max(0, onHand - reserved - quarantine),
    binCount: new Set(balances.map((b) => b.location)).size,
    lotNumbers: Array.from(new Set(balances.map((b) => b.lotNumber))).sort(),
    earliestExpiry: balances.map((b) => b.expiryDate).filter(Boolean).sort()[0] ?? null,
    location: primary?.location ?? existing?.location ?? 'UNASSIGNED',
    lotNumber: primary?.lotNumber ?? existing?.lotNumber,
    updatedAt: now,
    tenantCode: scope.tenantCode,
    warehouseCode: scope.warehouseCode,
  };

  if (existing?.id != null) {
    await db.inventory.update(existing.id, payload);
  } else if (onHand > 0 || balances.length > 0) {
    await db.inventory.add({ sku, product: sku, ...payload } as never);
  }
}

/**
 * Adds (or merges into) one physical stock dimension.
 *
 * Used by directed putaway, QC disposition and verified returns so incoming
 * units always land in a fully-addressed bin/lot/status row instead of being
 * dumped onto a per-SKU total.
 */
export async function upsertDimension(params: {
  scope: StockScope;
  sku: string;
  location: string;
  lotNumber: string;
  qtyDelta: number;
  stockStatus?: StockStatus;
  serialNumber?: string;
  expiryDate?: string | null;
  note?: string;
  operator: string;
  movementType?: 'inbound' | 'putaway' | 'return' | 'adjustment' | 'transfer' | 'qc_adjustment';
  referenceId?: string;
}): Promise<{ balanceId: number; onHandQty: number; created: boolean }> {
  const status: StockStatus = params.stockStatus ?? 'AVAILABLE';
  const location = String(params.location ?? '').trim().toUpperCase();
  const lotNumber = String(params.lotNumber ?? 'DEFAULT').trim() || 'DEFAULT';
  if (!location) throw new Error('VALIDATION_ERROR: a bin location is required to post stock');
  if (!Number.isFinite(params.qtyDelta) || params.qtyDelta === 0) {
    throw new Error('VALIDATION_ERROR: qtyDelta must be a non-zero number');
  }

  const now = new Date().toISOString();
  let balance = await db.stockBalances
    .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
    .equals([params.scope.tenantCode, params.scope.warehouseCode, location, params.sku, lotNumber, status])
    .first();

  let created = false;
  if (!balance) {
    if (params.qtyDelta < 0) {
      throw new Error(`STOCK_INSUFFICIENT: no ${params.sku} dimension at ${location}/${lotNumber} (${status}) to decrement`);
    }
    balance = {
      tenantCode: params.scope.tenantCode,
      warehouseCode: params.scope.warehouseCode,
      location,
      sku: params.sku,
      lotNumber,
      stockStatus: status,
      serialNumber: params.serialNumber,
      onHandQty: 0,
      reservedQty: 0,
      quarantineQty: status === 'QUARANTINE' || status === 'DAMAGED' ? 0 : 0,
      expiryDate: params.expiryDate ?? null,
      cloudId: null,
      version: 0,
      updatedAt: now,
    };
  }

  const nextOnHand = balance.onHandQty + params.qtyDelta;
  if (nextOnHand < 0) {
    throw new Error(
      `STOCK_INSUFFICIENT: ${location}/${lotNumber} holds ${balance.onHandQty} of ${params.sku}; cannot remove ${Math.abs(params.qtyDelta)}`,
    );
  }
  if (nextOnHand < balance.reservedQty) {
    throw new Error(
      `RESERVATION_MISMATCH: ${location}/${lotNumber} has ${balance.reservedQty} reserved; removing ${Math.abs(params.qtyDelta)} would strand a promise`,
    );
  }

  // A QUARANTINE/DAMAGED dimension is blocked in full: its quarantine count
  // always equals what it physically holds.
  const nextQuarantine = status === 'QUARANTINE' || status === 'DAMAGED' ? nextOnHand : balance.quarantineQty;
  let id: number;
  if (balance.id != null) {
    await db.stockBalances.update(balance.id, {
      onHandQty: nextOnHand,
      quarantineQty: nextQuarantine,
      expiryDate: params.expiryDate ?? balance.expiryDate ?? null,
      version: balance.version + 1,
      updatedAt: now,
    });
    id = balance.id;
    created = false;
  } else {
    id = await db.stockBalances.add({
      ...balance,
      onHandQty: nextOnHand,
      quarantineQty: nextQuarantine,
      version: 1,
      updatedAt: now,
    });
    created = true;
  }

  await db.inventoryMovements.add({
    sku: params.sku,
    type: params.movementType ?? 'adjustment',
    quantity: Math.abs(params.qtyDelta),
    fromLocation: params.qtyDelta < 0 ? location : undefined,
    toLocation: params.qtyDelta > 0 ? location : undefined,
    lotNumber,
    stockStatus: status,
    serialNumber: params.serialNumber,
    expiryDate: params.expiryDate ?? null,
    operator: params.operator,
    note: params.note,
    tenantCode: params.scope.tenantCode,
    warehouseCode: params.scope.warehouseCode,
    // Deterministic per (dimension, movement, version): an explicit reference is
    // reused so a retried GRN/putaway does not write a second ledger row.
    idempotencyKey:
      params.referenceId ??
      `dim:${params.scope.warehouseCode}:${params.sku}:${location}:${lotNumber}:${status}:${params.movementType ?? 'adjustment'}:v${
        created ? 1 : balance.version + 1
      }`,
    timestamp: now,
  } as never);

  await refreshInventoryRollup(params.sku, params.scope);
  return { balanceId: id, onHandQty: nextOnHand, created };
}

/**
 * Moves units between two dimensions inside one warehouse (bin transfer or a QC
 * status change). Both legs are validated before either is written.
 */
export async function transferDimension(params: {
  scope: StockScope;
  sku: string;
  qty: number;
  from: { location: string; lotNumber: string; stockStatus?: StockStatus };
  to: { location: string; lotNumber: string; stockStatus?: StockStatus };
  operator: string;
  note?: string;
  referenceId?: string;
}): Promise<{ fromBalanceId: number; toBalanceId: number }> {
  if (!Number.isFinite(params.qty) || params.qty <= 0) {
    throw new Error('VALIDATION_ERROR: transfer quantity must be positive');
  }
  const from = await upsertDimension({
    scope: params.scope,
    sku: params.sku,
    location: params.from.location,
    lotNumber: params.from.lotNumber,
    stockStatus: params.from.stockStatus ?? 'AVAILABLE',
    qtyDelta: -params.qty,
    operator: params.operator,
    movementType: params.from.stockStatus === 'QUARANTINE' || params.to.stockStatus === 'QUARANTINE' ? 'qc_adjustment' : 'transfer',
    note: params.note ?? `Transfer to ${params.to.location}/${params.to.lotNumber}`,
    referenceId: params.referenceId,
  });
  const to = await upsertDimension({
    scope: params.scope,
    sku: params.sku,
    location: params.to.location,
    lotNumber: params.to.lotNumber,
    stockStatus: params.to.stockStatus ?? 'AVAILABLE',
    qtyDelta: params.qty,
    operator: params.operator,
    movementType: params.from.stockStatus === 'QUARANTINE' || params.to.stockStatus === 'QUARANTINE' ? 'qc_adjustment' : 'transfer',
    note: params.note ?? `Transfer from ${params.from.location}/${params.from.lotNumber}`,
    referenceId: params.referenceId,
  });
  return { fromBalanceId: from.balanceId, toBalanceId: to.balanceId };
}

/**
 * Consumes (ships/picks) units from the EXACT dimension a reservation points
 * at: decrements on-hand and the reservation hold together, so a pick can never
 * silently draw from a different bin, lot or status.
 */
export async function consumeReservationUnits(
  reservation: {
    id?: number;
    reservationId: string;
    orderId: string;
    sku: string;
    quantity: number;
    location?: string;
    lotNumber?: string;
    serialNumbers?: string;
    tenantCode?: string;
    warehouseCode?: string;
  },
  params: { operator: string; qty?: number; movementType: 'pick' | 'pack' | 'outbound'; note?: string; scope: StockScope },
): Promise<{ consumed: number; location: string; lotNumber: string }> {
  const qty = Math.min(params.qty ?? reservation.quantity, reservation.quantity);
  if (qty <= 0) throw new Error('VALIDATION_ERROR: consumption quantity must be positive');

  const scope: StockScope = {
    tenantCode: reservation.tenantCode ?? params.scope.tenantCode,
    warehouseCode: reservation.warehouseCode ?? params.scope.warehouseCode,
  };
  const location = reservation.location ?? '';
  const lotNumber = reservation.lotNumber ?? 'DEFAULT';
  const now = new Date().toISOString();

  if (!location) {
    throw new Error(
      `RESERVATION_UNSCOPED: reservation ${reservation.reservationId} has no bin; re-allocate ${reservation.sku} before picking`,
    );
  }

  const balance = await db.stockBalances
    .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
    .equals([scope.tenantCode, scope.warehouseCode, location, reservation.sku, lotNumber, 'AVAILABLE'])
    .first();

  if (!balance || balance.id == null) {
    throw new Error(`BALANCE_MISSING: no ${reservation.sku} dimension at ${location}/${lotNumber}`);
  }
  if (balance.onHandQty < qty) {
    throw new Error(
      `STOCK_INSUFFICIENT: ${location}/${lotNumber} holds ${balance.onHandQty} of ${reservation.sku}, pick needs ${qty}`,
    );
  }
  if (balance.reservedQty < qty) {
    throw new Error(
      `RESERVATION_MISMATCH: ${location}/${lotNumber} has ${balance.reservedQty} reserved but ${qty} were requested`,
    );
  }

  await db.stockBalances.update(balance.id, {
    onHandQty: balance.onHandQty - qty,
    reservedQty: balance.reservedQty - qty,
    version: balance.version + 1,
    updatedAt: now,
  });

  const remaining = reservation.quantity - qty;
  if (reservation.id != null) {
    await db.inventoryReservations.update(reservation.id, {
      status: remaining > 0 ? 'allocated' : 'picked',
      quantity: remaining > 0 ? remaining : reservation.quantity,
    });
  }

  await db.inventoryMovements.add({
    sku: reservation.sku,
    type: params.movementType,
    quantity: qty,
    fromLocation: location,
    orderId: reservation.orderId,
    operator: params.operator,
    lotNumber,
    stockStatus: 'AVAILABLE',
    serialNumber: reservation.serialNumbers,
    note: params.note ?? `Reservation ${reservation.reservationId}`,
    tenantCode: scope.tenantCode,
    warehouseCode: scope.warehouseCode,
    timestamp: now,
  } as never);

  await refreshInventoryRollup(reservation.sku, scope);
  return { consumed: qty, location, lotNumber };
}

/**
 * Releases reserved units back to availability without moving physical stock.
 *
 * `options.status` records WHY the promise ended: a deliberate cancellation is
 * `released`, a promise that outlived its window is `expired`. The audit trail
 * must not flatten the two into one indistinguishable state.
 */
export async function releaseReservationUnits(
  reservation: {
    id?: number;
    reservationId: string;
    sku: string;
    quantity: number;
    location?: string;
    lotNumber?: string;
    tenantCode?: string;
    warehouseCode?: string;
  },
  scope: StockScope,
  options?: { status?: 'released' | 'expired'; reason?: string },
): Promise<boolean> {
  const endStatus = options?.status ?? 'released';
  const endNote = {
    ...(options?.reason ? { note: options.reason } : {}),
    releasedAt: new Date().toISOString(),
  };
  if (!reservation.location) {
    if (reservation.id != null) await db.inventoryReservations.update(reservation.id, { status: endStatus, ...endNote });
    return true;
  }
  const balance = await db.stockBalances
    .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
    .equals([
      reservation.tenantCode ?? scope.tenantCode,
      reservation.warehouseCode ?? scope.warehouseCode,
      reservation.location,
      reservation.sku,
      reservation.lotNumber ?? 'DEFAULT',
      'AVAILABLE',
    ])
    .first();

  if (balance?.id != null) {
    await db.stockBalances.update(balance.id, {
      reservedQty: Math.max(0, balance.reservedQty - reservation.quantity),
      version: balance.version + 1,
      updatedAt: new Date().toISOString(),
    });
  }
  if (reservation.id != null) await db.inventoryReservations.update(reservation.id, { status: endStatus, ...endNote });
  await refreshInventoryRollup(reservation.sku, scope);
  return true;
}

/**
 * Scan verification for a pick line.
 *
 * Accepts the SKU barcode, a serial number bound to the reserved dimension, or
 * the lot code. Anything else is a hard `PICK_SCAN_MISMATCH` — the operator must
 * re-scan rather than being allowed to confirm a guessed quantity.
 */
export async function verifyPickScan(params: {
  sku: string;
  scannedCode: string;
  location?: string;
  lotNumber?: string;
  scope: StockScope;
}): Promise<{ ok: true; matched: 'serial' | 'barcode' | 'lot' } | { ok: false; code: string; error: string }> {
  const code = (params.scannedCode ?? '').trim();
  if (!code) return { ok: false, code: 'SCAN_REQUIRED', error: 'A barcode or serial must be scanned to confirm a pick' };

  // 1. Serial bound to this exact dimension
  const serial = await db.serialNumbers.where('serialNumber').equals(code).first();
  if (serial) {
    if (serial.sku !== params.sku) {
      return {
        ok: false,
        code: 'PICK_SCAN_MISMATCH',
        error: `Scanned serial ${code} belongs to ${serial.sku}, not ${params.sku}`,
      };
    }
    if (params.location && serial.location && serial.location !== params.location) {
      return {
        ok: false,
        code: 'PICK_SCAN_MISMATCH',
        error: `Serial ${code} is stored at ${serial.location}; pick list says ${params.location}`,
      };
    }
    return { ok: true, matched: 'serial' };
  }

  // 2. SKU barcode registered for this warehouse
  const barcodes = await db.inventory
    .where('[tenantCode+warehouseCode+sku]')
    .equals([params.scope.tenantCode, params.scope.warehouseCode, params.sku])
    .toArray();
  if (barcodes.some((b) => b.barcode === code || b.sku === code || b.rfidTag === code)) {
    return { ok: true, matched: 'barcode' };
  }

  // 3. Lot label scan
  if (params.lotNumber && code.toUpperCase() === params.lotNumber.toUpperCase()) {
    return { ok: true, matched: 'lot' };
  }

  return {
    ok: false,
    code: 'PICK_SCAN_MISMATCH',
    error: `Scanned ${code} does not match ${params.sku} at ${params.location ?? 'the assigned bin'}`,
  };
}

/** Expires stale local reservations so their units return to availability. */
export async function expireStaleReservations(scope: StockScope): Promise<number> {
  const nowIso = new Date().toISOString();
  const stale = await db.inventoryReservations
    .where('[tenantCode+warehouseCode]')
    .equals([scope.tenantCode, scope.warehouseCode])
    .and((r) => (r.status === 'reserved' || r.status === 'allocated') && Boolean(r.expiresAt) && r.expiresAt < nowIso)
    .toArray();

  for (const r of stale) {
    await releaseReservationUnits(r, scope, {
      status: 'expired',
      reason: `Reservation window closed at ${r.expiresAt}; units returned to availability`,
    });
  }
  return stale.length;
}
