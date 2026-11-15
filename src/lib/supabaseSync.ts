/**
 * YESI-WMS Hardened Cloud + Edge Transactional Sync Engine (v3.0 Enterprise)
 *
 * Enterprise Reliability, Security & Performance Guarantees:
 *  1. Strict Payload & Scope Validation: rejects malformed/unscoped outbox payloads
 *     before enqueueing; every cloud RPC receives explicit tenantCode + warehouseCode
 *     plus the signed server session token, so scope is enforced server-side too.
 *  2. Indexed Transactional Outbox: pending cloud commands live in the
 *     `outboxEvents` IndexedDB table (one row per command), NOT in a single JSON
 *     `preferences` blob. Multiple browser tabs therefore observe, retry and DLQ
 *     individual events instead of last-writer-wins overwriting each other.
 *  3. Idempotency & Exponential Backoff + Jitter: every event carries a unique
 *     `idempotencyKey`, `nextRetryAt`, `leaseOwner`/`leaseUntil`, and dead-letter
 *     quarantine after 8 retries so poison items never block healthy floor ops.
 *     The same key is replayed server-side through `wms_command_idempotency`.
 *  4. Cross-Tab Single-Flight: drains and pulls take an exclusive lock
 *     (`navigator.locks` when available, in-process mutex fallback) so two tabs
 *     cannot double-submit the same floor transaction.
 *  5. Stock Granularity Integrity: cloud balances are materialised per physical
 *     dimension (warehouse → bin → SKU → lot → stock status → serial) into
 *     `stockBalances`. `inventory` is rebuilt as a derived rollup for legacy
 *     screens, so bin/lot/status detail is never silently collapsed or summed
 *     across warehouses.
 *  6. Non-Destructive Conflict Resolution: local orders/tasks in active floor
 *     states (Picking, Packed, ReadyToShip, Shipped) are never regressed by stale
 *     cloud rows.
 *  7. Operational Telemetry: sync latency, queue depth and DLQ pressure are
 *     reported to `wms_record_telemetry` and surfaced in `v_wms_kpi_summary`.
 */

import { db, availableQty, type OutboxEvent, type StockBalance, type StockStatus } from './db';
import { getDeviceId } from './deviceRegistry';
import {
  supabase,
  WMS_DEFAULT_WAREHOUSE,
  WMS_TENANT_CODE,
  isSupabaseConfigured,
  getActiveServerSessionToken,
  subscribeWmsRealtime,
  type WmsKpiSummaryRow,
} from './supabase';

export type OutboxOperationType =
  | 'stock_movement'
  | 'inbound_grn'
  | 'qc_release'
  | 'putaway_complete'
  | 'allocate_order'
  | 'confirm_pick'
  | 'confirm_packed'
  | 'dispatch_order'
  | 'return_rma'
  | 'audit_log';

/**
 * @deprecated v2 shape of a queued cloud operation. Retained only so legacy
 * callers that read the old JSON blob type-check; the live queue is the indexed
 * `OutboxEvent` rows in `db.outboxEvents`.
 */
export interface OutboxSyncItem {
  id: string;
  idempotencyKey: string;
  tenantCode: string;
  warehouseCode: string;
  createdAt: string;
  op: OutboxOperationType;
  payload: Record<string, unknown>;
  retries: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface SyncSnapshotState {
  status: 'idle' | 'syncing' | 'synced' | 'offline' | 'unconfigured' | 'error';
  warehouseCode: string;
  lastSyncAt: string | null;
  pendingOutbox: number;
  deadLetterCount: number;
  cloudLatencyMs: number | null;
  lastError: string | null;
  kpis: WmsKpiSummaryRow | null;
}

const LEGACY_OUTBOX_PREF_KEY = 'wms_sync_outbox_v2';
const LEGACY_DEAD_LETTER_PREF_KEY = 'wms_sync_dead_letter_v1';
const WAREHOUSE_PREF_KEY = 'wms_active_warehouse_code';
const MIGRATION_PREF_KEY = 'wms_outbox_migrated_to_table_v1';
const TELEMETRY_FLUSH_PREF_KEY = 'wms_telemetry_last_flush_at';

/** Mirrors `wms_event_outbox.max_retries` before the database moves it to DLQ. */
const MAX_RETRIES = 8;
const MAX_BATCH_SIZE = 15;
const REALTIME_DEBOUNCE_MS = 2_500;
const BACKGROUND_SYNC_INTERVAL_MS = 60_000;
/** Lease window for a claimed event; long enough for one RPC round trip. */
const LEASE_MS = 45_000;
const OUTBOX_LOCK = 'yesi-wms:outbox-drain';
/** Mirrors the `wms_inventory_balances.stock_status` CHECK constraint. */
export const STOCK_STATUSES: string[] = ['AVAILABLE', 'RESERVED', 'QUARANTINE', 'DAMAGED', 'HOLD'];
const PULL_LOCK = 'yesi-wms:cloud-pull';
const TELEMETRY_LOCK = 'yesi-wms:telemetry-flush';

/** Identifies this browser tab when claiming outbox leases. */
const tabId: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : String(Math.random()).slice(2, 10);

/** Fallback mutex for runtimes without the Web Locks API. */
const inProcessLocks = new Map<string, Promise<unknown>>();

let currentState: SyncSnapshotState = {
  status: isSupabaseConfigured ? 'idle' : 'unconfigured',
  warehouseCode: WMS_DEFAULT_WAREHOUSE,
  lastSyncAt: null,
  pendingOutbox: 0,
  deadLetterCount: 0,
  cloudLatencyMs: null,
  lastError: null,
  kpis: null,
};

const listeners = new Set<(state: SyncSnapshotState) => void>();

function emitState(patch: Partial<SyncSnapshotState>) {
  currentState = { ...currentState, ...patch };
  for (const fn of listeners) {
    fn(currentState);
  }
}

export function getSyncState(): SyncSnapshotState {
  return currentState;
}

export function subscribeSyncState(listener: (state: SyncSnapshotState) => void): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export async function getActiveWarehouseCode(): Promise<string> {
  try {
    const pref = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
    if (pref?.value) {
      currentState.warehouseCode = pref.value;
      return pref.value;
    }
  } catch {
    // ignore
  }
  return currentState.warehouseCode || WMS_DEFAULT_WAREHOUSE;
}

export async function setActiveWarehouseCode(code: string): Promise<void> {
  const clean = code.trim().toUpperCase();
  if (!clean) throw new Error('Warehouse code cannot be empty');
  const existing = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: clean, createdAt: new Date().toISOString() });
  } else {
    await db.preferences.add({ key: WAREHOUSE_PREF_KEY, value: clean, createdAt: new Date().toISOString() });
  }
  emitState({ warehouseCode: clean });
  if (isSupabaseConfigured) {
    await pullCloudSnapshotToEdge(clean);
  }
}

/**
 * Strict schema & business invariant validation for outbox operations.
 * Rejects invalid payloads immediately instead of poisoning the sync queue.
 */
export function validateOutboxPayload(
  op: OutboxOperationType,
  payload: Record<string, unknown>
): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }

  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const positiveInt = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const nonZeroNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v !== 0;

  switch (op) {
    case 'stock_movement':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'stock_movement requires non-empty sku' };
      if (!nonZeroNum(Number(payload.qtyDelta))) return { valid: false, error: 'stock_movement requires non-zero qtyDelta' };
      if (!nonEmpty(payload.transactionType)) return { valid: false, error: 'stock_movement requires transactionType' };
      if (!nonEmpty(payload.location)) return { valid: false, error: 'stock_movement requires the exact bin location' };
      if (!nonEmpty(payload.lotNumber)) return { valid: false, error: 'stock_movement requires the exact lotNumber' };
      if (payload.stockStatus != null && !STOCK_STATUSES.includes(String(payload.stockStatus).toUpperCase())) {
        return { valid: false, error: `stock_movement stockStatus must be one of ${STOCK_STATUSES.join(', ')}` };
      }
      if (payload.expiryDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.expiryDate))) {
        return { valid: false, error: 'stock_movement expiryDate must be ISO yyyy-mm-dd' };
      }
      return { valid: true };

    case 'inbound_grn':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'inbound_grn requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'inbound_grn requires positive qty' };
      if (!nonEmpty(payload.bin)) return { valid: false, error: 'inbound_grn requires the receiving bin' };
      if (!nonEmpty(payload.lotNumber)) return { valid: false, error: 'inbound_grn requires the lotNumber' };
      return { valid: true };

    case 'qc_release':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'qc_release requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'qc_release requires positive qty' };
      if (!['release', 'scrap'].includes(String(payload.disposition))) {
        return { valid: false, error: 'qc_release disposition must be release or scrap' };
      }
      return { valid: true };

    case 'putaway_complete':
      if (!nonEmpty(payload.taskNumber)) return { valid: false, error: 'putaway_complete requires taskNumber' };
      if (!nonEmpty(payload.actualLocation)) return { valid: false, error: 'putaway_complete requires actualLocation' };
      return { valid: true };

    case 'confirm_pick':
      if (!nonEmpty(payload.taskNumber)) return { valid: false, error: 'confirm_pick requires taskNumber' };
      // Scan verification is mandatory: an unconfirmed barcode means the pick
      // cannot be recorded, preventing short-picks from silently shipping.
      if (!nonEmpty(payload.scannedCode)) {
        return { valid: false, error: 'confirm_pick requires scannedCode (barcode/serial must be scanned, not typed)' };
      }
      if (payload.pickedQty != null && !positiveInt(Number(payload.pickedQty))) {
        return { valid: false, error: 'confirm_pick pickedQty must be a positive integer when supplied' };
      }
      return { valid: true };

    case 'allocate_order':
    case 'confirm_packed':
    case 'dispatch_order':
      if (!nonEmpty(payload.orderId)) return { valid: false, error: `${op} requires non-empty orderId` };
      return { valid: true };

    case 'return_rma':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'return_rma requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'return_rma requires positive qty' };
      return { valid: true };

    case 'audit_log':
      if (!nonEmpty(payload.action)) return { valid: false, error: 'audit_log requires action' };
      return { valid: true };

    default:
      return { valid: false, error: `Unknown outbox operation: ${String(op)}` };
  }
}

export function computeBackoffMs(retries: number): number {
  const baseMs = Math.min(300_000, 1_500 * Math.pow(2, Math.max(0, retries - 1)));
  const jitter = Math.floor(Math.random() * 600);
  return baseMs + jitter;
}

// ─── Indexed Transactional Outbox (v3) ─────────────────────────────────
//
// Pending cloud commands are individual IndexedDB rows. This replaces the
// legacy single-JSON `preferences` blob (last-writer-wins across tabs, opaque
// dead-letter queue, whole-queue rewrite on every retry tick).

/** Runs `fn` under an exclusive named lock so tabs cannot double-submit. */
async function withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<{ ran: boolean; value?: T }> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    let ran = false;
    let value: T | undefined;
    await locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return; // another tab/context owns it
      ran = true;
      value = await fn();
    });
    return ran ? { ran: true, value } : { ran: false };
  }
  // Fallback (no Web Locks): in-process mutex.
  const held = inProcessLocks.get(name);
  if (held) return { ran: false };
  inProcessLocks.set(name, Promise.resolve());
  try {
    return { ran: true, value: await fn() };
  } finally {
    inProcessLocks.delete(name);
  }
}

/**
 * One-time migration of the legacy JSON-blob queue into `outboxEvents`.
 * Idempotent and safe to run on every boot.
 */
export async function migrateLegacyOutbox(): Promise<{ migrated: number; deadLettered: number }> {
  try {
    const flag = await db.preferences.where('key').equals(MIGRATION_PREF_KEY).first();
    if (flag?.value === 'done') return { migrated: 0, deadLettered: 0 };

    const legacyQueue = await readLegacyPref<LegacyOutboxItem>(LEGACY_OUTBOX_PREF_KEY);
    const legacyDlq = await readLegacyPref<LegacyOutboxItem>(LEGACY_DEAD_LETTER_PREF_KEY);
    const nowIso = new Date().toISOString();
    let migrated = 0;
    let deadLettered = 0;

    await db.transaction('rw', [db.outboxEvents, db.preferences], async () => {
      for (const [item, status] of [
        ...legacyQueue.map((i) => [i, 'pending'] as const),
        ...legacyDlq.map((i) => [i, 'dead_letter'] as const),
      ]) {
        if (!item?.idempotencyKey || !item?.op) continue;
        const exists = await db.outboxEvents.where('idempotencyKey').equals(item.idempotencyKey).first();
        if (exists) continue;
        await db.outboxEvents.add({
          eventId: item.id || crypto.randomUUID(),
          idempotencyKey: item.idempotencyKey,
          tenantCode: item.tenantCode || WMS_TENANT_CODE,
          warehouseCode: item.warehouseCode || WMS_DEFAULT_WAREHOUSE,
          command: LEGACY_OP_TO_COMMAND[item.op] ?? item.op,
          payload: item.payload ?? {},
          status,
          retryCount: Number(item.retries ?? 0),
          nextRetryAt: Number(item.nextAttemptAt ?? 0),
          lastError: item.lastError ?? null,
          createdAt: item.createdAt || nowIso,
          updatedAt: nowIso,
        } as OutboxEvent);
        if (status === 'dead_letter') deadLettered++;
        else migrated++;
      }

      await db.preferences.put({
        key: MIGRATION_PREF_KEY,
        value: 'done',
        createdAt: nowIso,
      });
      // Legacy blobs are no longer read; clear them so no stale duplicate queue exists.
      await db.preferences.where('key').equals(LEGACY_OUTBOX_PREF_KEY).delete();
      await db.preferences.where('key').equals(LEGACY_DEAD_LETTER_PREF_KEY).delete();
    });

    return { migrated, deadLettered };
  } catch {
    return { migrated: 0, deadLettered: 0 };
  }
}

interface LegacyOutboxItem {
  id?: string;
  idempotencyKey?: string;
  tenantCode?: string;
  warehouseCode?: string;
  createdAt?: string;
  op?: string;
  payload?: Record<string, unknown>;
  retries?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

async function readLegacyPref<T>(key: string): Promise<T[]> {
  try {
    const pref = await db.preferences.where('key').equals(key).first();
    if (!pref?.value) return [];
    const parsed = JSON.parse(pref.value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Maps v2 outbox op names onto the migration-008 `wms_execute_command` names. */
const LEGACY_OP_TO_COMMAND: Record<string, string> = {
  stock_movement: 'record_stock_movement',
  inbound_grn: 'receive_inbound_grn',
  qc_release: 'release_qc_hold',
  putaway_complete: 'complete_putaway_task',
  allocate_order: 'allocate_order_fefo',
  confirm_pick: 'confirm_pick_task',
  confirm_packed: 'confirm_order_packed',
  dispatch_order: 'dispatch_order',
  return_rma: 'process_return_rma',
};

/** Canonical command name for an outbox operation. */
export function toCommandName(op: OutboxOperationType | string): string {
  return LEGACY_OP_TO_COMMAND[op] ?? String(op);
}

export async function getDeadLetterOutbox(): Promise<OutboxEvent[]> {
  try {
    return await db.outboxEvents
      .where('status')
      .anyOf(['dead_letter', 'failed'])
      .reverse()
      .sortBy('createdAt');
  } catch {
    return [];
  }
}

export async function getPendingOutbox(): Promise<OutboxEvent[]> {
  try {
    return await db.outboxEvents.where('status').anyOf(['pending', 'processing']).sortBy('nextRetryAt');
  } catch {
    return [];
  }
}

/** Manually re-queue a dead-lettered command for another attempt. */
export async function retryDeadLetterEvent(eventId: string): Promise<boolean> {
  try {
    const ev = await db.outboxEvents.where('eventId').equals(eventId).first();
    if (!ev || ev.id == null) return false;
    await db.outboxEvents.update(ev.id, {
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    scheduleThrottledDrain();
    return true;
  } catch {
    return false;
  }
}

/** Permanently remove a dead-lettered command (audited locally first). */
export async function discardDeadLetterEvent(eventId: string): Promise<boolean> {
  try {
    const ev = await db.outboxEvents.where('eventId').equals(eventId).first();
    if (!ev || ev.id == null) return false;
    if (ev.status !== 'dead_letter' && ev.status !== 'failed') return false;
    await db.auditLogs.add({
      action: 'OUTBOX_EVENT_DISCARDED',
      details: `${ev.command} ${ev.idempotencyKey} discarded from DLQ: ${ev.lastError ?? 'no error recorded'}`,
      operator: 'Operator',
      timestamp: new Date().toISOString(),
    });
    await db.outboxEvents.delete(ev.id);
    return true;
  } catch {
    return false;
  }
}

export async function getOutboxCounts(): Promise<{ pending: number; processing: number; failed: number; deadLetter: number }> {
  try {
    const rows = await db.outboxEvents.toArray();
    let pending = 0;
    let processing = 0;
    let failed = 0;
    let deadLetter = 0;
    for (const r of rows) {
      if (r.status === 'pending') pending++;
      else if (r.status === 'processing') processing++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'dead_letter') deadLetter++;
    }
    return { pending, processing, failed, deadLetter };
  } catch {
    return { pending: 0, processing: 0, failed: 0, deadLetter: 0 };
  }
}

let scheduledDrainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleThrottledDrain(delayMs = 450) {
  if (!isSupabaseConfigured) return;
  if (scheduledDrainTimer) return;
  scheduledDrainTimer = setTimeout(() => {
    scheduledDrainTimer = null;
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void drainLocalOutbox();
    }
  }, delayMs);
}

export async function enqueueCloudOperation(
  op: OutboxOperationType,
  payload: Record<string, unknown>,
  explicitIdempotencyKey?: string,
): Promise<{ queued: boolean; idempotencyKey?: string; error?: string }> {
  const check = validateOutboxPayload(op, payload);
  if (!check.valid) {
    return { queued: false, error: check.error };
  }

  const warehouseCode = String(payload.warehouseCode || (await getActiveWarehouseCode())).trim().toUpperCase();
  const tenantCode = String(payload.tenantCode || WMS_TENANT_CODE).trim().toUpperCase();
  const idempotencyKey = explicitIdempotencyKey || `${tenantCode}:${warehouseCode}:${toCommandName(op)}:${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  try {
    const dupe = await db.outboxEvents.where('idempotencyKey').equals(idempotencyKey).first();
    if (dupe) return { queued: true, idempotencyKey };

    await db.outboxEvents.add({
      eventId: crypto.randomUUID(),
      idempotencyKey,
      tenantCode,
      warehouseCode,
      command: toCommandName(op),
      payload,
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      publishedAt: null,
    } as OutboxEvent);

    const counts = await getOutboxCounts();
    emitState({ pendingOutbox: counts.pending + counts.processing, deadLetterCount: counts.deadLetter });
    scheduleThrottledDrain();
    return { queued: true, idempotencyKey };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Executes one outbox command against the authoritative cloud.
 *
 * All lifecycle mutations go through the strictly idempotent
 * `wms_execute_command` RPC (server-side `wms_command_idempotency` table), so a
 * retry after an ambiguous network failure can never double-move stock.
 */
async function executeOutboxItem(item: OutboxEvent): Promise<Record<string, unknown>> {
  const p = item.payload ?? {};
  const sessionToken = getActiveServerSessionToken();
  const wh = item.warehouseCode;
  const tenant = item.tenantCode;
  const command = item.command;

  const baseArgs = {
    p_command: command,
    p_idempotency_key: item.idempotencyKey,
    p_tenant_code: tenant,
    p_warehouse_code: wh,
    p_session_token: sessionToken,
    p_device_id: getDeviceId(),
  };

  const buildPayload = (): Record<string, unknown> => {
    switch (command) {
      case 'record_stock_movement':
        return {
          p_sku_code: String(p.sku ?? '').trim(),
          p_qty_delta: Number(p.qtyDelta ?? 0),
          p_transaction_type: String(p.transactionType ?? 'adjustment'),
          p_location_code: String(p.location ?? 'PHONE-A-01'),
          p_lot_number: String(p.lotNumber ?? 'DEFAULT'),
          p_reference_type: p.referenceType ? String(p.referenceType) : null,
          p_reference_id: p.referenceId ? String(p.referenceId) : null,
          p_operator: String(p.operator ?? 'System'),
          p_note: p.note ? String(p.note) : null,
          p_stock_status: String(p.stockStatus ?? 'AVAILABLE').toUpperCase(),
          p_serial_number: p.serialNumber ? String(p.serialNumber) : null,
          p_expiry_date: p.expiryDate ? String(p.expiryDate) : null,
        };
      case 'receive_inbound_grn':
        return {
          p_sku_code: String(p.sku ?? '').trim(),
          p_qty: Number(p.qty ?? 0),
          p_description: p.description ? String(p.description) : null,
          p_po_number: p.poNumber ? String(p.poNumber) : null,
          p_supplier_name: String(p.supplier ?? 'Direct Supplier'),
          p_receiving_bin: String(p.bin ?? 'RECV-DOCK-01'),
          p_lot_number: String(p.lotNumber ?? 'DEFAULT'),
          p_qc_status: String(p.qcStatus ?? 'pending'),
          p_operator: String(p.operator ?? 'Operator'),
        };
      case 'release_qc_hold':
        return {
          p_sku_code: String(p.sku ?? '').trim(),
          p_quantity: Number(p.qty ?? 0),
          p_disposition: String(p.disposition ?? 'release'),
          p_reason: String(p.reason ?? 'QC Inspection'),
          p_inspector: String(p.operator ?? 'Supervisor'),
          p_lot_number: String(p.lotNumber ?? 'DEFAULT'),
        };
      case 'complete_putaway_task':
        return {
          p_task_number: String(p.taskNumber ?? '').trim(),
          p_actual_location: String(p.actualLocation ?? '').trim(),
          p_operator: String(p.operator ?? 'Operator'),
        };
      case 'allocate_order_fefo':
        return {
          p_order_number: String(p.orderId ?? '').trim(),
          p_operator: String(p.operator ?? 'System'),
        };
      case 'confirm_pick_task':
        return {
          p_task_number: String(p.taskNumber ?? '').trim(),
          p_scanned_code: p.scannedCode ? String(p.scannedCode) : null,
          p_picked_qty: p.pickedQty != null ? Number(p.pickedQty) : null,
          p_operator: String(p.operator ?? 'Operator'),
        };
      case 'confirm_order_packed':
        return {
          p_order_number: String(p.orderId ?? '').trim(),
          p_box_name: String(p.boxName ?? 'Standard Carton'),
          p_weight_kg: Number(p.weightKg ?? 0.4),
          p_operator: String(p.operator ?? 'Operator'),
        };
      case 'dispatch_order':
        return {
          p_order_number: String(p.orderId ?? '').trim(),
          p_carrier_name: String(p.carrier ?? 'GBS Express'),
          p_tracking_number: p.trackingNumber ? String(p.trackingNumber) : null,
          p_operator: String(p.operator ?? 'Operator'),
          p_allow_direct_override: Boolean(p.allowDirectOverride),
        };
      case 'process_return_rma':
        return {
          p_order_number: String(p.orderId ?? ''),
          p_sku_code: String(p.sku ?? '').trim(),
          p_quantity: Number(p.qty ?? 0),
          p_reason: String(p.reason ?? 'Return'),
          p_disposition: String(p.disposition ?? 'quarantine'),
          p_operator: String(p.operator ?? 'Operator'),
        };
      default:
        // Unknown commands pass through their payload verbatim.
        return { ...p };
    }
  };

  const { data, error } = await supabase.rpc('wms_execute_command', {
    ...baseArgs,
    p_payload: buildPayload(),
  });

  if (error) throw new Error(error.message);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok === false) {
    throw new Error(String(result.error_code ? `${result.error_code}: ${result.error ?? ''}`.trim() : result.error ?? 'Command rejected'));
  }
  return result;
}

/** Errors that must never be retried: replaying them cannot succeed. */
const PERMANENT_ERROR_CODES = [
  'VALIDATION_ERROR',
  'LIFECYCLE_VIOLATION',
  'PERMISSION_DENIED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'AUTH_REQUIRED',
  'TENANT_REQUIRED',
  'WAREHOUSE_FORBIDDEN',
  'LEDGER_IMMUTABLE',
  'STOCK_INSUFFICIENT',
  'SCAN_MISMATCH',
  'PICK_SCAN_MISMATCH',
  'BOOTSTRAP_ALREADY_COMPLETED',
  'PASSWORD_TOO_WEAK',
];

function isPermanentFailure(message: string): boolean {
  return PERMANENT_ERROR_CODES.some((code) => message.includes(code));
}

async function markEvent(id: number, patch: Partial<OutboxEvent>): Promise<void> {
  await db.outboxEvents.update(id, { ...patch, updatedAt: new Date().toISOString() });
}

/**
 * Drains the local outbox under an exclusive cross-tab lock.
 *
 * Events are claimed with a lease (`leaseOwner` + `leaseUntil`) before the RPC
 * fires, so a tab that dies mid-flight leaves a recoverable lease instead of an
 * orphaned or duplicated transaction. Expired leases are reclaimed automatically.
 */
export async function drainLocalOutbox(): Promise<{ processed: number; remaining: number; skippedLock?: boolean }> {
  if (!isSupabaseConfigured) {
    const counts = await getOutboxCounts();
    emitState({ status: 'unconfigured', pendingOutbox: counts.pending, deadLetterCount: counts.deadLetter });
    return { processed: 0, remaining: counts.pending };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const counts = await getOutboxCounts();
    emitState({ status: 'offline', pendingOutbox: counts.pending + counts.processing, deadLetterCount: counts.deadLetter });
    return { processed: 0, remaining: counts.pending + counts.processing };
  }

  const outcome = await withExclusiveLock(OUTBOX_LOCK, async () => {
    await migrateLegacyOutbox();

    const nowMs = Date.now();
    const owner = `${getDeviceId()}:${tabId}`;

    // Reclaim leases whose owner died (crashed tab / killed worker).
    const stale = await db.outboxEvents.where('leaseUntil').belowOrEqual(nowMs).toArray();
    for (const ev of stale) {
      if (ev.id != null && ev.status === 'processing') {
        await markEvent(ev.id, { status: 'pending', leaseOwner: null, leaseUntil: null });
      }
    }

    const eligible = (
      await db.outboxEvents
        .where('status')
        .equals('pending')
        .and((ev) => (ev.nextRetryAt ?? 0) <= nowMs)
        .sortBy('nextRetryAt')
    ).slice(0, MAX_BATCH_SIZE);

    const countsBefore = await getOutboxCounts();
    if (eligible.length === 0) {
      emitState({
        pendingOutbox: countsBefore.pending + countsBefore.processing,
        deadLetterCount: countsBefore.deadLetter,
      });
      return { processed: 0, remaining: countsBefore.pending + countsBefore.processing };
    }

    emitState({ status: 'syncing', pendingOutbox: countsBefore.pending + countsBefore.processing });

    let processed = 0;
    let retried = 0;
    let deadLettered = 0;
    let lastError: string | null = null;

    for (const item of eligible) {
      if (item.id == null) continue;
      // Claim with a lease so no other tab can run the same event concurrently.
      const claimed = await db.outboxEvents
        .where('id')
        .equals(item.id)
        .and((ev) => ev.status === 'pending' && (ev.leaseUntil ?? 0) <= Date.now())
        .modify({
          status: 'processing',
          leaseOwner: owner,
          leaseUntil: Date.now() + LEASE_MS,
        });
      if (!claimed) continue;

      const started = performance.now();
      try {
        const result = await executeOutboxItem(item);
        const elapsed = Math.round(performance.now() - started);
        await markEvent(item.id, {
          status: 'published',
          retryCount: item.retryCount,
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
          response: result,
          publishedAt: new Date().toISOString(),
        });
        processed++;
        void enqueueTelemetry('sync.rpc_latency_ms', elapsed, 'ms', item.tenantCode, item.warehouseCode, {
          command: item.command,
          outcome: result.deduplicated ? 'deduplicated' : 'applied',
        });
      } catch (err) {
        const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        lastError = errMsg;
        const retries = (item.retryCount ?? 0) + 1;
        const elapsed = Math.round(performance.now() - started);

        // Permanent business rejections and exhausted retries both quarantine
        // the event, mirroring the server-side DLQ transition.
        if (isPermanentFailure(errMsg) || retries >= MAX_RETRIES) {
          await markEvent(item.id, {
            status: 'dead_letter',
            retryCount: retries,
            leaseOwner: null,
            leaseUntil: null,
            lastError: errMsg,
          });
          deadLettered++;
          await db.auditLogs
            .add({
              action: 'OUTBOX_DEAD_LETTERED',
              details: `${item.command} ${item.idempotencyKey} quarantined after ${retries} attempt(s): ${errMsg}`,
              operator: String(item.payload?.operator ?? 'System'),
              timestamp: new Date().toISOString(),
            })
            .catch(() => {});
        } else {
          await markEvent(item.id, {
            status: 'pending',
            retryCount: retries,
            nextRetryAt: Date.now() + computeBackoffMs(retries),
            leaseOwner: null,
            leaseUntil: null,
            lastError: errMsg,
          });
          retried++;
        }
        void enqueueTelemetry('sync.rpc_latency_ms', elapsed, 'ms', item.tenantCode, item.warehouseCode, {
          command: item.command,
          outcome: 'failed',
        });
      }
    }

    const counts = await getOutboxCounts();
    emitState({
      status: deadLettered > 0 ? 'error' : retried > 0 ? 'error' : 'synced',
      pendingOutbox: counts.pending + counts.processing,
      deadLetterCount: counts.deadLetter,
      lastSyncAt: new Date().toISOString(),
      lastError,
    });

    return { processed, remaining: counts.pending + counts.processing };
  });

  if (!outcome.ran) return { processed: 0, remaining: currentState.pendingOutbox, skippedLock: true };
  return outcome.value ?? { processed: 0, remaining: currentState.pendingOutbox };
}

// ─── Operational Telemetry ───────────────────────────────────────────────

const TELEMETRY_FLUSH_INTERVAL_MS = 20_000;
let telemetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Records a client-side operational metric locally and schedules a batched
 * flush into `wms_operational_telemetry` (feeds `avg_sync_latency_ms` and the
 * allocation-conflict counters in `v_wms_kpi_summary`).
 */
export async function enqueueTelemetry(
  metric: string,
  value: number,
  unit: string,
  tenantCode?: string,
  warehouseCode?: string,
  labels?: Record<string, unknown>,
): Promise<void> {
  if (!Number.isFinite(value)) return;
  const tenant = (tenantCode || WMS_TENANT_CODE).trim().toUpperCase();
  const wh = (warehouseCode || (await getActiveWarehouseCode())).trim().toUpperCase();
  try {
    await db.telemetryEvents.add({
      metric,
      value,
      unit,
      tenantCode: tenant,
      warehouseCode: wh,
      deviceId: getDeviceId(),
      labels: labels ?? {},
      ts: Date.now(),
      synced: 0,
    });
  } catch {
    return;
  }
  scheduleTelemetryFlush();
}

function scheduleTelemetryFlush() {
  if (!isSupabaseConfigured) return;
  if (telemetryTimer) return;
  telemetryTimer = setTimeout(() => {
    telemetryTimer = null;
    void flushTelemetry();
  }, TELEMETRY_FLUSH_INTERVAL_MS);
}

/** Ships up to 200 unsynced telemetry rows to the cloud in one RPC call. */
export async function flushTelemetry(): Promise<number> {
  if (!isSupabaseConfigured) return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;

  const outcome = await withExclusiveLock(TELEMETRY_LOCK, async () => {
    let unsynced: { id?: number; metric: string; value: number; unit: string; tenantCode: string; warehouseCode: string; deviceId?: string; labels?: Record<string, unknown>; ts: number }[] = [];
    try {
      unsynced = await db.telemetryEvents.where('synced').equals(0).limit(200).toArray();
    } catch {
      return 0;
    }
    if (unsynced.length === 0) return 0;

    const batch = unsynced.map((t) => ({
      metric: t.metric,
      value: t.value,
      unit: t.unit,
      tenant_code: t.tenantCode,
      warehouse_code: t.warehouseCode,
      device_id: t.deviceId ?? null,
      labels: t.labels ?? {},
      ts: new Date(t.ts).toISOString(),
    }));

    const sessionToken = getActiveServerSessionToken();
    const { error } = await supabase.rpc('wms_record_telemetry', {
      p_batch: batch,
      p_tenant_code: WMS_TENANT_CODE,
      p_warehouse_code: batch[0]?.warehouse_code ?? WMS_DEFAULT_WAREHOUSE,
      p_device_id: getDeviceId(),
      p_session_id: sessionToken ? sessionToken.slice(0, 16) : null,
    });
    if (error) return 0;

    const ids = unsynced.map((t) => t.id).filter((v): v is number => typeof v === 'number');
    if (ids.length > 0) {
      await db.telemetryEvents.where('id').anyOf(ids).modify({ synced: 1 }).catch(() => {});
    }
    try {
      await db.preferences.put({
        key: TELEMETRY_FLUSH_PREF_KEY,
        value: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    } catch {
      // non-fatal
    }
    return ids.length;
  });

  return outcome.ran ? (outcome.value ?? 0) : 0;
}


//Rank order lifecycle stages so cloud sync never regresses advanced local floor states
const ORDER_STAGE_RANK: Record<string, number> = {
  Pending: 1,
  CrossDock: 2,
  Picking: 3,
  Packed: 4,
  ReadyToShip: 5,
  Shipped: 6,
  Returned: 7,
};

let isPulling = false;
let activeWarehouseIdCache: string | null = null;

/**
 * Reconciles authoritative cloud state into local Dexie IndexedDB inside atomic
 * transactions with conflict protection and partial-failure resilience.
 *
 * Cross-tab single-flight: the reconciliation runs under the `PULL_LOCK` Web
 * Lock, so two open tabs cannot interleave snapshot writes and resurrect rows
 * the other tab just retired. If another tab already holds the lock this call
 * returns false without touching IndexedDB.
 */
export async function pullCloudSnapshotToEdge(explicitWarehouse?: string): Promise<boolean> {
  if (!isSupabaseConfigured) {
    emitState({ status: 'unconfigured' });
    return false;
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    emitState({ status: 'offline' });
    return false;
  }

  const outcome = await withExclusiveLock(PULL_LOCK, () => runCloudPull(explicitWarehouse));
  return outcome.ran ? (outcome.value ?? false) : false;
}

async function runCloudPull(explicitWarehouse?: string): Promise<boolean> {
  if (isPulling) return false;

  isPulling = true;
  const started = performance.now();
  const warehouseCode = (explicitWarehouse || (await getActiveWarehouseCode())).trim().toUpperCase();
  emitState({ status: 'syncing', warehouseCode });

  try {
    await migrateLegacyOutbox();
    // Push before pull so the snapshot we cache already reflects our own
    // offline floor work instead of overwriting it with stale cloud state.
    await drainLocalOutbox();

    // Strictly verify tenant + warehouse relationship
    const { data: tenantRow, error: tenantErr } = await supabase
      .from('wms_tenants')
      .select('id, code')
      .eq('code', WMS_TENANT_CODE)
      .eq('status', 'active')
      .maybeSingle();

    if (tenantErr || !tenantRow) {
      throw new Error(tenantErr?.message || `Tenant ${WMS_TENANT_CODE} not found or inactive`);
    }

    const { data: wh, error: whErr } = await supabase
      .from('wms_warehouses')
      .select('id, tenant_id, code, name')
      .eq('tenant_id', tenantRow.id)
      .eq('code', warehouseCode)
      .eq('status', 'active')
      .maybeSingle();

    if (whErr || !wh) {
      throw new Error(whErr?.message || `Warehouse ${warehouseCode} not active under ${WMS_TENANT_CODE}`);
    }

    activeWarehouseIdCache = wh.id;

    // Use allSettled so partial network/query glitches do not abort the entire sync snapshot
    const settled = await Promise.allSettled([
      supabase.from('wms_skus').select('*').eq('tenant_id', wh.tenant_id).eq('is_active', true),
      supabase.from('wms_inventory_balances').select('*').eq('warehouse_id', wh.id),
      supabase.from('wms_zones').select('*').eq('warehouse_id', wh.id),
      supabase.from('wms_sales_orders').select('*').eq('warehouse_id', wh.id).limit(200),
      supabase.from('wms_purchase_orders').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_dock_appointments').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_putaway_tasks').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_qc_inspections').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('v_wms_kpi_summary').select('*').eq('warehouse_code', warehouseCode).maybeSingle(),
    ]);

    const unwrap = <T>(idx: number): T | null => {
      const r = settled[idx];
      if (r.status === 'fulfilled' && !r.value.error) {
        return r.value.data as T;
      }
      return null;
    };

    const skusData = unwrap<Array<Record<string, unknown>>>(0);
    const balancesData = unwrap<Array<Record<string, unknown>>>(1);
    const zonesData = unwrap<Array<Record<string, unknown>>>(2);
    const ordersData = unwrap<Array<Record<string, unknown>>>(3);
    const posData = unwrap<Array<Record<string, unknown>>>(4);
    const docksData = unwrap<Array<Record<string, unknown>>>(5);
    const putawayData = unwrap<Array<Record<string, unknown>>>(6);
    const qcData = unwrap<Array<Record<string, unknown>>>(7);
    const kpiData = unwrap<WmsKpiSummaryRow>(8);

    const nowIso = new Date().toISOString();

    // ── Stock granularity ─────────────────────────────────────────────────
    // Cloud balances are materialised ONE ROW PER PHYSICAL DIMENSION
    // (warehouse → bin → SKU → lot → stock status → serial). They are never
    // summed across bins, lots or statuses, and never mixed across warehouses:
    // the previous implementation collapsed every balance of a SKU into a
    // single {qty, location, lot} entry, which silently destroyed FEFO lot
    // identity, bin identity and quarantine/damaged segregation.
    const dimensionRows: StockBalance[] = [];
    for (const b of balancesData || []) {
      const skuCode = String(b.sku_code || '');
      if (!skuCode) continue;
      const status = String(b.stock_status || 'AVAILABLE').toUpperCase();
      const onHand = Number(b.on_hand_qty ?? 0);
      const reserved = Number(b.reserved_qty ?? 0);
      const quarantine = Number(b.quarantine_qty ?? 0);
      const damaged = Number(b.damaged_qty ?? 0);
      dimensionRows.push({
        tenantCode: WMS_TENANT_CODE,
        warehouseCode,
        location: String(b.location_code || 'UNASSIGNED'),
        sku: skuCode,
        lotNumber: String(b.lot_number || 'DEFAULT'),
        stockStatus: (STOCK_STATUSES.includes(status) ? status : 'AVAILABLE') as StockStatus,
        serialNumber: b.serial_number ? String(b.serial_number) : undefined,
        onHandQty: onHand,
        reservedQty: reserved,
        quarantineQty: quarantine + damaged,
        expiryDate: b.expiry_date ? String(b.expiry_date) : null,
        cloudId: b.id ? String(b.id) : null,
        version: Number(b.version ?? 0),
        updatedAt: String(b.updated_at || nowIso),
      });
    }

    // Atomic batched Dexie transaction for Balances + Inventory + Zones + Orders
    await db.transaction('rw', [db.stockBalances, db.inventory, db.zoneCapacities, db.orders], async () => {
      // Replace only THIS warehouse's dimension rows; other warehouses stay intact.
      await db.stockBalances
        .where('[tenantCode+warehouseCode]')
        .equals([WMS_TENANT_CODE, warehouseCode])
        .delete();
      if (dimensionRows.length > 0) await db.stockBalances.bulkAdd(dimensionRows);

      if (skusData && skusData.length > 0) {
        // Derived rollup per (warehouse, SKU) — clearly labelled as a view over
        // `stockBalances`, with the FEFO-critical lot/expiry detail preserved.
        const rollup = new Map<string, { onHand: number; available: number; reserved: number; quarantine: number; bins: Set<string>; lots: Set<string>; earliestExpiry: string | null }>();
        for (const r of dimensionRows) {
          const cur = rollup.get(r.sku) ?? { onHand: 0, available: 0, reserved: 0, quarantine: 0, bins: new Set<string>(), lots: new Set<string>(), earliestExpiry: null as string | null };
          cur.onHand += r.onHandQty;
          cur.reserved += r.reservedQty;
          cur.quarantine += r.quarantineQty;
          cur.available += availableQty(r);
          cur.bins.add(r.location);
          cur.lots.add(r.lotNumber);
          if (r.expiryDate && (!cur.earliestExpiry || r.expiryDate < cur.earliestExpiry)) cur.earliestExpiry = r.expiryDate;
          rollup.set(r.sku, cur);
        }

        // Only touch this warehouse's inventory rows.
        const localInv = await db.inventory
          .where('[tenantCode+warehouseCode]')
          .equals([WMS_TENANT_CODE, warehouseCode])
          .toArray();
        const localBySku = new Map(localInv.map((i) => [i.sku, i]));

        for (const s of skusData) {
          const skuCode = String(s.sku_code || '');
          if (!skuCode) continue;
          const agg = rollup.get(skuCode);
          const existing = localBySku.get(skuCode);
          const primaryDimension = dimensionRows
            .filter((d) => d.sku === skuCode && d.stockStatus === 'AVAILABLE')
            .sort((a, b) => (a.expiryDate ?? '9999') .localeCompare(b.expiryDate ?? '9999') || b.onHandQty - a.onHandQty)[0];

          const payload = {
            sku: skuCode,
            product: String(s.name || skuCode),
            // Rollup of this warehouse's bins only — never cross-warehouse.
            stock: agg ? agg.onHand : existing?.stock ?? 0,
            availableStock: agg ? agg.available : undefined,
            reservedStock: agg ? agg.reserved : undefined,
            quarantineStock: agg ? agg.quarantine : undefined,
            binCount: agg ? agg.bins.size : 0,
            lotNumbers: agg ? Array.from(agg.lots).sort() : [],
            earliestExpiry: agg?.earliestExpiry ?? null,
            location: primaryDimension?.location || String(s.default_location_code || existing?.location || 'UNASSIGNED'),
            category: String(s.category || 'General'),
            velocity: String(s.velocity_class || 'medium') as 'high' | 'medium' | 'low',
            weight: Number(s.weight_kg || 0.4),
            reorderPoint: Number(s.reorder_point ?? 5),
            reorderQty: Number(s.reorder_qty ?? 15),
            barcode: s.primary_barcode ? String(s.primary_barcode) : existing?.barcode,
            costPerUnit: Number(s.unit_price || s.unit_cost || 0),
            lotNumber: primaryDimension?.lotNumber || existing?.lotNumber,
            serializable: Boolean(s.serializable),
            fefoPriority: Number(s.fefo_priority ?? 50),
            tenantCode: WMS_TENANT_CODE,
            warehouseCode,
            updatedAt: String(s.updated_at || nowIso),
          };
          if (existing?.id != null) {
            await db.inventory.update(existing.id, payload);
          } else {
            await db.inventory.add(payload);
          }
        }
      }

      if (zonesData && zonesData.length > 0) {
        const localZones = await db.zoneCapacities.toArray();
        const zoneMap = new Map(localZones.map((z) => [z.zone, z]));
        for (const z of zonesData) {
          const zCode = String(z.zone_code || '');
          if (!zCode) continue;
          const existing = zoneMap.get(zCode);
          const zPayload = {
            zone: zCode,
            maxCapacity: Number(z.max_capacity || 200),
            currentUtilization: Number(z.current_utilization || 0),
            category: String(z.category_target || 'General'),
            velocityTarget: (String(z.velocity_target || 'high') as 'high' | 'medium' | 'low'),
          };
          if (existing?.id != null) {
            await db.zoneCapacities.update(existing.id, zPayload);
          } else {
            await db.zoneCapacities.add(zPayload);
          }
        }
      }

      if (ordersData && ordersData.length > 0) {
        const localOrders = await db.orders
          .where('[tenantCode+warehouseCode]')
          .equals([WMS_TENANT_CODE, warehouseCode])
          .toArray();
        const orderMap = new Map(localOrders.map((o) => [o.orderId, o]));
        for (const o of ordersData) {
          const ordNum = String(o.order_number || '');
          if (!ordNum) continue;
          const existing = orderMap.get(ordNum);
          const rawCloudStatus = String(o.status || 'Pending');
          const mappedCloudStatus = (
            rawCloudStatus === 'Allocated'
              ? 'Picking'
              : rawCloudStatus === 'Delivered'
                ? 'Shipped'
                : rawCloudStatus
          ) as 'Pending' | 'Picking' | 'Packed' | 'ReadyToShip' | 'Shipped' | 'Returned' | 'CrossDock';

          const normPriority = (
            ['urgent', 'high', 'normal'].includes(String(o.priority || 'normal'))
              ? String(o.priority)
              : 'normal'
          ) as 'urgent' | 'high' | 'normal';

          if (existing?.id != null) {
            // Conflict Resolution: Never downgrade a local order that has progressed further on the floor
            const localRank = ORDER_STAGE_RANK[existing.status] ?? 0;
            const cloudRank = ORDER_STAGE_RANK[mappedCloudStatus] ?? 0;
            const winningStatus = localRank > cloudRank ? existing.status : mappedCloudStatus;

            await db.orders.update(existing.id, {
              status: winningStatus,
              priority: normPriority,
              carrier: o.carrier_name ? String(o.carrier_name) : existing.carrier,
              trackingNumber: o.tracking_number ? String(o.tracking_number) : existing.trackingNumber,
              channel: o.channel ? String(o.channel) : existing.channel,
              // Real dispatch timestamp from the cloud ledger — never derived
              // locally, so "shipped today" reports actual carrier handoffs.
              shippedAt:
                o.shipped_at != null
                  ? String(o.shipped_at)
                  : ['Shipped', 'Delivered'].includes(String(o.status || ''))
                    ? existing.shippedAt || String(o.updated_at || nowIso)
                    : null,
              tenantCode: WMS_TENANT_CODE,
              warehouseCode,
              updatedAt: String(o.updated_at || nowIso),
            });
          } else {
            await db.orders.add({
              orderId: ordNum,
              status: mappedCloudStatus,
              requiredSkus: String(o.required_skus || ''),
              priority: normPriority,
              createdAt: String(o.created_at || nowIso),
              updatedAt: String(o.updated_at || nowIso),
              carrier: String(o.carrier_name || 'GBS Express'),
              service: String(o.service_level || 'Ozon Global'),
              trackingNumber: String(o.tracking_number || ordNum),
              channel: o.channel ? String(o.channel) : undefined,
              shippedAt: o.shipped_at ? String(o.shipped_at) : null,
              tenantCode: WMS_TENANT_CODE,
              warehouseCode,
            });
          }
        }
      }
    });

    // Secondary transaction for Inbound POs, Dock, Putaway & QC
    await db.transaction('rw', [db.purchaseOrders, db.dockAppointments, db.putawayTasks, db.qcHolds], async () => {
      const whScoped = { tenantCode: WMS_TENANT_CODE, warehouseCode };
      if (posData && posData.length > 0) {
        for (const po of posData) {
          const poNum = String(po.po_number || '');
          if (!poNum) continue;
          const existing = await db.purchaseOrders.where('poNumber').equals(poNum).first();
          const rawSt = String(po.status || 'open');
          const poPayload = {
            poNumber: poNum,
            supplier: String(po.supplier_name || 'Supplier'),
            status: (rawSt === 'draft' || rawSt === 'asn_received' ? 'open' : rawSt) as
              | 'open'
              | 'partial'
              | 'received'
              | 'closed'
              | 'cancelled',
            expectedDelivery: String(po.expected_delivery || nowIso.slice(0, 10)),
            items: JSON.stringify(po.lines || []),
            totalValue: Number(po.total_value || 0),
            currency: String(po.currency || 'USD'),
            notes: po.notes ? String(po.notes) : undefined,
            createdAt: String(po.created_at || nowIso),
            updatedAt: String(po.updated_at || nowIso),
          };
          if (existing?.id != null) {
            await db.purchaseOrders.update(existing.id, poPayload);
          } else {
            await db.purchaseOrders.add(poPayload);
          }
        }
      }

      if (docksData && docksData.length > 0) {
        for (const d of docksData) {
          const appNum = String(d.appointment_number || '');
          if (!appNum) continue;
          const existing = await db.dockAppointments.where('appointmentId').equals(appNum).first();
          const rawDockStatus = String(d.status || 'scheduled');
          const normDockStatus = (
            rawDockStatus === 'arrived' ? 'checked_in' : rawDockStatus
          ) as 'scheduled' | 'checked_in' | 'unloading' | 'completed' | 'no_show' | 'cancelled';
          const dPayload = {
            appointmentId: appNum,
            supplier: String(d.supplier_name || 'Supplier'),
            poNumber: d.po_number ? String(d.po_number) : undefined,
            dockNumber: String(d.dock_door || 'DOCK-01'),
            scheduledDate: String(d.scheduled_date || nowIso.slice(0, 10)),
            scheduledTime: String(d.scheduled_time || '09:00'),
            estimatedDuration: Number(d.estimated_duration_min || 60),
            status: normDockStatus,
            carrier: d.carrier_name ? String(d.carrier_name) : undefined,
            palletCount: Number(d.pallet_count || 1),
            asnNumber: d.asn_number ? String(d.asn_number) : undefined,
            operator: String(d.operator_name || 'System'),
            createdAt: String(d.created_at || nowIso),
          };
          if (existing?.id != null) {
            await db.dockAppointments.update(existing.id, dPayload);
          } else {
            await db.dockAppointments.add(dPayload);
          }
        }
      }

      if (putawayData && putawayData.length > 0) {
        for (const pt of putawayData) {
          const taskNum = String(pt.task_number || '');
          if (!taskNum) continue;
          const existing = await db.putawayTasks
            .where('[tenantCode+warehouseCode]')
            .equals([WMS_TENANT_CODE, warehouseCode])
            .and((t) => t.taskId === taskNum)
            .first();
          if (!existing) {
            const rawSrc = String(pt.source_type || 'receiving');
            const normSrc = (rawSrc === 'return' ? 'returns' : rawSrc) as
              | 'receiving'
              | 'returns'
              | 'transfer'
              | 'qc_release'
              | 'cross_dock';
            const rawMethod = String(pt.putaway_method || 'direct');
            const normMethod = (
              ['direct', 'zone', 'cross_dock', 'consolidation'].includes(rawMethod) ? rawMethod : 'direct'
            ) as 'direct' | 'zone' | 'cross_dock' | 'consolidation';

            await db.putawayTasks.add({
              taskId: taskNum,
              sku: String(pt.sku_code || ''),
              product: String(pt.product_name || pt.sku_code || ''),
              quantity: Number(pt.quantity || 1),
              lotNumber: pt.lot_number ? String(pt.lot_number) : undefined,
              sourceLocation: String(pt.source_location || 'RECV-DOCK-01'),
              sourceType: normSrc,
              suggestedLocation: String(pt.suggested_location || 'PHONE-A-01'),
              actualLocation: pt.actual_location ? String(pt.actual_location) : undefined,
              destinationZone: String(pt.destination_zone || 'PHONE-A'),
              status: (String(pt.status || 'pending') as 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'),
              priority: (['urgent', 'high', 'normal'].includes(String(pt.priority)) ? String(pt.priority) : 'normal') as 'urgent' | 'high' | 'normal',
              createdAt: String(pt.created_at || nowIso),
              qcStatus: (String(pt.qc_status || 'passed') === 'pending' ? 'pending' : 'passed'),
              putawayMethod: normMethod,
              operator: String(pt.operator_name || 'System'),
              ...whScoped,
            });
          }
        }
      }

      if (qcData && qcData.length > 0 && (await db.qcHolds.count()) === 0) {
        for (const q of qcData) {
          const qStatus = String(q.status || 'hold');
          await db.qcHolds.add({
            sku: String(q.sku_code || ''),
            lotNumber: q.lot_number ? String(q.lot_number) : undefined,
            quantity: Number(q.quantity || 1),
            reason: String(q.reason || 'QC Hold'),
            status: (qStatus === 'scrapped' ? 'rejected' : qStatus) as 'hold' | 'released' | 'rejected',
            operator: String(q.inspector_name || 'System'),
            createdAt: String(q.created_at || nowIso),
            releasedAt: q.released_at ? String(q.released_at) : undefined,
            ...whScoped,
          });
        }
      }
    });

    const latency = Math.round(performance.now() - started);
    const counts = await getOutboxCounts();
    emitState({
      status: 'synced',
      warehouseCode,
      lastSyncAt: nowIso,
      pendingOutbox: counts.pending + counts.processing,
      deadLetterCount: counts.deadLetter,
      cloudLatencyMs: latency,
      lastError: null,
      kpis: kpiData || null,
    });

    // Operational telemetry feeds avg_sync_latency_ms in v_wms_kpi_summary.
    void enqueueTelemetry('sync.latency_ms', latency, 'ms', WMS_TENANT_CODE, warehouseCode, {
      balances: dimensionRows.length,
      orders: ordersData?.length ?? 0,
      skus: skusData?.length ?? 0,
      outbox_pending: counts.pending,
      outbox_dead_letter: counts.deadLetter,
    });
    void flushTelemetry();
    return true;
  } catch (err) {
    const counts = await getOutboxCounts();
    const message = err instanceof Error ? err.message : String(err);
    emitState({
      status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      pendingOutbox: counts.pending + counts.processing,
      deadLetterCount: counts.deadLetter,
      lastError: message,
    });
    void enqueueTelemetry('sync.failure', 1, 'count', WMS_TENANT_CODE, warehouseCode, {
      reason: message.slice(0, 120),
    });
    return false;
  } finally {
    isPulling = false;
  }
}

let engineStarted = false;

export function startHybridSyncEngine(explicitWarehouse?: string): () => void {
  if (!isSupabaseConfigured) {
    emitState({ status: 'unconfigured' });
    return () => {};
  }
  if (engineStarted) return () => {};
  engineStarted = true;

  let realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
  let unsubRealtime: (() => void) | null = null;

  void (async () => {
    const wh = explicitWarehouse || (await getActiveWarehouseCode());
    await pullCloudSnapshotToEdge(wh);
    unsubRealtime = subscribeWmsRealtime(activeWarehouseIdCache, () => {
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          void pullCloudSnapshotToEdge();
        }
      }, REALTIME_DEBOUNCE_MS);
    });
  })();

  const handleOnline = () => {
    void drainLocalOutbox().then(() => pullCloudSnapshotToEdge());
  };
  const handleOffline = () => {
    emitState({ status: 'offline' });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }

  // Throttled 60s background sync that respects page visibility
  const timer = setInterval(() => {
    const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (isVisible && (typeof navigator === 'undefined' || navigator.onLine)) {
      void drainLocalOutbox();
    }
  }, BACKGROUND_SYNC_INTERVAL_MS);

  return () => {
    engineStarted = false;
    if (realtimeDebounce) clearTimeout(realtimeDebounce);
    unsubRealtime?.();
    clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    }
  };
}

export async function listCloudWarehouses(): Promise<
  Array<{ id: string; code: string; name: string; city: string; warehouse_type: string; status: string }>
> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data: tenant } = await supabase
      .from('wms_tenants')
      .select('id')
      .eq('code', WMS_TENANT_CODE)
      .maybeSingle();
    if (!tenant) return [];
    const { data } = await supabase
      .from('wms_warehouses')
      .select('id, code, name, city, warehouse_type, status')
      .eq('tenant_id', tenant.id)
      .order('is_default', { ascending: false });
    return (data || []) as Array<{
      id: string;
      code: string;
      name: string;
      city: string;
      warehouse_type: string;
      status: string;
    }>;
  } catch {
    return [];
  }
}
