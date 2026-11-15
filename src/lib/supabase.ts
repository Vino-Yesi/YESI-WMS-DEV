import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import { runtimeConfig } from './config';

/**
 * Hardened Supabase Cloud Client
 *
 * SECURITY GUARANTEES:
 *  - ZERO hardcoded fallback URLs or publishable keys in source code.
 *  - If VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is absent or fails validation,
 *    `isSupabaseConfigured` is false and the app runs cleanly in Offline-Edge Mode.
 *  - Auth tokens are NOT persisted in plaintext localStorage (`persistSession: false`).
 *  - Every Edge API request includes explicit `x-tenant-code`, `x-warehouse-code`,
 *    and in-memory signed `x-session-token`.
 */

export const SUPABASE_URL: string = runtimeConfig.supabaseUrl ?? '';
export const SUPABASE_ANON_KEY: string = runtimeConfig.supabaseAnonKey ?? '';
export const WMS_TENANT_CODE: string = runtimeConfig.tenantCode;
export const WMS_DEFAULT_WAREHOUSE: string = runtimeConfig.defaultWarehouseCode;
export const isSupabaseConfigured: boolean = runtimeConfig.cloudEnabled;

// In-memory active session token (never written in plaintext to localStorage)
let activeServerSessionToken: string | null = null;

export function setActiveServerSessionToken(token: string | null): void {
  activeServerSessionToken = token;
}

export function getActiveServerSessionToken(): string | null {
  return activeServerSessionToken;
}

const realClient: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 5,
        },
      },
    })
  : null;

/**
 * Safe accessor — returns null when cloud is unconfigured so callers can fail
 * gracefully instead of hitting a public fallback project.
 */
export function getSupabaseClient(): SupabaseClient | null {
  return realClient;
}

// Proxy exported for typed compatibility; throws descriptive offline error if invoked while unconfigured
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!realClient) {
      if (prop === 'auth') {
        return {
          signOut: async () => ({ error: null }),
          getSession: async () => ({ data: { session: null }, error: null }),
        };
      }
      if (prop === 'rpc') {
        return async () => ({
          data: null,
          error: { message: 'CLOUD_UNCONFIGURED: Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY' },
        });
      }
      if (prop === 'from') {
        return () => ({
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: [], error: { message: 'CLOUD_UNCONFIGURED' } }),
              maybeSingle: () => Promise.resolve({ data: null, error: { message: 'CLOUD_UNCONFIGURED' } }),
              order: () => Promise.resolve({ data: [], error: { message: 'CLOUD_UNCONFIGURED' } }),
              limit: () => Promise.resolve({ data: [], error: { message: 'CLOUD_UNCONFIGURED' } }),
            }),
            limit: () => Promise.resolve({ data: [], error: { message: 'CLOUD_UNCONFIGURED' } }),
          }),
          insert: () => Promise.resolve({ data: null, error: { message: 'CLOUD_UNCONFIGURED' } }),
          upsert: () => Promise.resolve({ data: null, error: { message: 'CLOUD_UNCONFIGURED' } }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'CLOUD_UNCONFIGURED' } }) }),
        });
      }
      return undefined;
    }
    const value = Reflect.get(realClient, prop, realClient);
    return typeof value === 'function' ? value.bind(realClient) : value;
  },
});

export interface WmsKpiSummaryRow {
  tenant_id: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  active_skus: number;
  total_on_hand: number;
  total_reserved: number;
  total_available: number;
  low_stock_skus: number;
  open_orders: number;
  shipped_orders: number;
  open_pick_tasks: number;
  open_putaway_tasks: number;
  active_qc_holds: number;
  total_returns: number;
  outbox_pending: number;
  /** v3 (migration 008): real dispatch + reliability columns */
  shipped_today: number;
  outbox_dead_letter: number;
  allocation_conflicts: number;
  avg_sync_latency_ms: number | null;
  quarantine_units: number;
  active_bins: number;
}

export interface WmsEdgeSecurityPosture {
  cors_mode: 'strict_allowlist' | 'deny_all_browser_origins';
  allowed_origin_count: number;
  metrics_auth: 'enabled' | 'disabled';
  webhook_auth: 'enabled' | 'disabled';
}

export interface WmsEdgeHealthResponse {
  status: 'healthy' | 'degraded' | 'offline';
  service: string;
  version: string;
  warehouse: string;
  latency_ms: number;
  timestamp: string;
  kpis: WmsKpiSummaryRow | null;
  error: string | null;
  /** Present on gateway v3.0.0+ */
  security?: WmsEdgeSecurityPosture;
}

/** Result of the v3 gateway's real leased outbox delivery. */
export interface WmsFlushResult {
  ok: boolean;
  /** Kept for backwards compatibility: delivered + broadcast. */
  published_count: number;
  claimed?: number;
  delivered?: number;
  broadcast?: number;
  failed?: number;
  dead_lettered?: number;
  http_targets?: string[];
  failures?: Array<Record<string, unknown>>;
  latency_ms?: number;
  error?: string;
}

export interface WmsOutboxMetrics {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  dead_letter: number;
  leased: number;
  stale_leases: number;
  dead_letter_queue: Array<{
    id: string;
    event_type: string;
    aggregate_id: string | null;
    retry_count: number;
    error_message: string | null;
    created_at: string;
    last_attempt_at: string | null;
  }>;
}

export async function checkEdgeGatewayHealth(warehouseCode = WMS_DEFAULT_WAREHOUSE): Promise<WmsEdgeHealthResponse> {
  const started = performance.now();
  if (!isSupabaseConfigured) {
    return {
      status: 'offline',
      service: 'yesi-wms-edge-api',
      version: '3.0.0',
      warehouse: warehouseCode,
      latency_ms: 0,
      timestamp: new Date().toISOString(),
      kpis: null,
      error: 'Cloud config missing (Offline-Edge Mode active)',
    };
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/wms-api?action=health&warehouse=${encodeURIComponent(warehouseCode)}`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          'x-tenant-code': WMS_TENANT_CODE,
          'x-warehouse-code': warehouseCode,
        },
      }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as WmsEdgeHealthResponse;
  } catch (err) {
    return {
      status: 'offline',
      service: 'yesi-wms-edge-api',
      version: '3.0.0',
      warehouse: warehouseCode,
      latency_ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
      kpis: null,
      error: err instanceof Error ? err.message : 'Network unreachable',
    };
  }
}

async function callEdgeGateway<T>(
  action: string,
  opts: { warehouseCode?: string; body?: Record<string, unknown>; query?: Record<string, string>; requireSession?: boolean },
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  if (!isSupabaseConfigured) {
    return { ok: false, status: 0, data: null, error: 'Cloud not configured (Offline-Edge Mode)' };
  }
  const warehouseCode = (opts.warehouseCode || WMS_DEFAULT_WAREHOUSE).trim().toUpperCase();
  const sessionToken = getActiveServerSessionToken();
  if (opts.requireSession !== false && !sessionToken) {
    return { ok: false, status: 401, data: null, error: 'Authenticated server session required' };
  }

  const query = new URLSearchParams({ action, ...(opts.query ?? {}) });
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/wms-api?${query.toString()}`, {
      method: opts.body ? 'POST' : 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'x-tenant-code': WMS_TENANT_CODE,
        'x-warehouse-code': warehouseCode,
        'x-device-id': typeof localStorage !== 'undefined' ? localStorage.getItem('vortex_device_id') || '' : '',
        ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
      },
      body: opts.body
        ? JSON.stringify({ action, tenant_code: WMS_TENANT_CODE, warehouse_code: warehouseCode, ...opts.body })
        : undefined,
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, data: body ?? null, error: body?.error || `HTTP ${res.status}` };
    return { ok: true, status: res.status, data: body ?? null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Asks the v3 edge gateway to claim a leased batch of `wms_event_outbox` rows
 * and deliver them to every configured HTTP subscriber (HMAC-signed), then
 * report each outcome back through `wms_complete_outbox_event`.
 */
export async function flushCloudOutbox(warehouseCode = WMS_DEFAULT_WAREHOUSE): Promise<WmsFlushResult> {
  const res = await callEdgeGateway<Record<string, unknown>>('flush_outbox', {
    warehouseCode,
    body: { action: 'flush_outbox' },
  });
  const data = res.data ?? {};
  if (!res.ok || data.ok === false) {
    return { ok: false, published_count: 0, error: res.error || String(data.error ?? 'Gateway refused the flush') };
  }
  const delivered = Number(data.delivered ?? 0);
  const broadcast = Number(data.broadcast ?? 0);
  return {
    ok: true,
    // v2 reported a single counter; v3 splits HTTP deliveries from realtime
    // broadcasts. Keep the legacy field meaningful for existing callers.
    published_count: Number(data.published_count ?? delivered + broadcast),
    claimed: Number(data.claimed ?? 0),
    delivered,
    broadcast,
    failed: Number(data.failed ?? 0),
    dead_lettered: Number(data.dead_lettered ?? 0),
    http_targets: Array.isArray(data.http_targets) ? (data.http_targets as string[]) : [],
    failures: Array.isArray(data.failures) ? (data.failures as Array<Record<string, unknown>>) : [],
    latency_ms: Number(data.latency_ms ?? 0),
  };
}

/** Live outbox counters + the dead-letter queue from `wms_get_outbox_metrics`. */
export async function fetchCloudOutboxMetrics(warehouseCode = WMS_DEFAULT_WAREHOUSE): Promise<WmsOutboxMetrics | null> {
  const res = await callEdgeGateway<WmsOutboxMetrics>('outbox_metrics', {
    warehouseCode,
    body: { action: 'outbox_metrics' },
  });
  return res.ok ? res.data : null;
}

/** First-run bootstrap probe (`wms_get_bootstrap_status`). */
export async function fetchBootstrapStatus(): Promise<{
  bootstrap_required: boolean;
  tenant_code: string | null;
  active_users: number;
  users_requiring_rotation: number;
  bootstrap_completed_at: string | null;
} | null> {
  const res = await callEdgeGateway<Record<string, unknown>>('bootstrap_status', { requireSession: false });
  if (!res.ok || !res.data) return null;
  const d = res.data;
  return {
    bootstrap_required: Boolean(d.bootstrap_required),
    tenant_code: (d.tenant_code as string) ?? null,
    active_users: Number(d.active_users ?? 0),
    users_requiring_rotation: Number(d.users_requiring_rotation ?? 0),
    bootstrap_completed_at: (d.bootstrap_completed_at as string) ?? null,
  };
}

/**
 * Runs one server-authoritative lifecycle command through
 * `wms_execute_command` (strictly idempotent via `wms_command_idempotency`).
 */
export async function executeCloudCommand(
  command: string,
  payload: Record<string, unknown>,
  opts: { warehouseCode?: string; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; data: Record<string, unknown> | null; error?: string }> {
  const res = await callEdgeGateway<Record<string, unknown>>('command', {
    warehouseCode: opts.warehouseCode,
    body: {
      action: 'command',
      command,
      payload,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    },
  });
  return { ok: res.ok && res.data?.ok !== false, data: res.data, error: res.error || (res.data?.error as string | undefined) };
}

/** Reports a batch of client telemetry samples to `wms_operational_telemetry`. */
export async function pushTelemetryBatch(
  events: Array<Record<string, unknown>>,
  warehouseCode = WMS_DEFAULT_WAREHOUSE,
): Promise<boolean> {
  const res = await callEdgeGateway<Record<string, unknown>>('telemetry', {
    warehouseCode,
    body: { action: 'telemetry', events },
  });
  return res.ok;
}

export function subscribeWmsRealtime(
  warehouseId: string | null,
  onTableChange: (table: string, eventType: string) => void
): () => void {
  if (!realClient) return () => {};
  let channel: RealtimeChannel | null = null;
  const filter = warehouseId ? `warehouse_id=eq.${warehouseId}` : undefined;
  try {
    channel = realClient
      .channel(`wms-floor-${warehouseId || 'global'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_inventory_balances', ...(filter ? { filter } : {}) },
        (payload) => onTableChange('wms_inventory_balances', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_sales_orders', ...(filter ? { filter } : {}) },
        (payload) => onTableChange('wms_sales_orders', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_putaway_tasks', ...(filter ? { filter } : {}) },
        (payload) => onTableChange('wms_putaway_tasks', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_qc_inspections', ...(filter ? { filter } : {}) },
        (payload) => onTableChange('wms_qc_inspections', payload.eventType)
      )
      .subscribe();
  } catch {
    channel = null;
  }

  return () => {
    if (channel && realClient) {
      void realClient.removeChannel(channel);
    }
  };
}
