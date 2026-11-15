import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * YESI-WMS Edge API Gateway v3.0.0
 *
 * Hardening delivered in this revision:
 *  - Strict CORS: browser requests (any request carrying an `Origin` header) are
 *    rejected unless the origin is explicitly listed in `WMS_ALLOWED_ORIGINS`.
 *    The previous behaviour reflected arbitrary origins / fell back to `*`.
 *  - `action=metrics` requires `WMS_METRICS_TOKEN` (Bearer, x-metrics-token or
 *    ?token=), compared in constant time. Unset token => endpoint is disabled.
 *  - `action=webhook_order` requires `WMS_WEBHOOK_SECRET` (raw shared secret in
 *    `x-webhook-secret`, or HMAC-SHA256 of the raw body in `x-yesi-signature`).
 *    Duplicate provider events are deduplicated by `wms_ingest_webhook`.
 *  - `action=flush_outbox` performs REAL delivery: it claims a leased batch with
 *    `wms_claim_outbox_batch` (FOR UPDATE SKIP LOCKED), POSTs each event to every
 *    active `wms_integration_endpoints.webhook_url` with an HMAC signature, and
 *    reports the outcome through `wms_complete_outbox_event` (retry + DLQ).
 *  - `action=command` is the server-authoritative lifecycle entry point: it
 *    validates the signed session and forwards to the strictly idempotent
 *    `wms_execute_command` RPC.
 *  - `action=telemetry` persists batched client operational metrics.
 */

const VERSION = "3.0.0";
const CORS_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-tenant-code, x-warehouse-code, x-session-token, x-webhook-secret, x-yesi-signature, x-idempotency-key, x-metrics-token, x-device-id";

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function configuredOrigins(): string[] {
  return (Deno.env.get("WMS_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Strict origin policy.
 * - Requests WITHOUT an Origin header (Prometheus, curl, server-to-server,
 *   Tauri desktop) are permitted; CORS does not apply to them.
 * - Requests WITH an Origin header must match the allowlist exactly.
 */
function evaluateOrigin(origin: string | null): { allowed: boolean; headers: Record<string, string> } {
  const allow = configuredOrigins();
  const base = {
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };

  if (!origin) return { allowed: true, headers: base };

  if (allow.length === 0 || !allow.includes(origin.replace(/\/+$/, ""))) {
    // Fail closed: never echo an unlisted origin, never return "*".
    return { allowed: false, headers: base };
  }

  return {
    allowed: true,
    headers: { ...base, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "false" },
  };
}

/** Length-independent constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a ?? "");
  const bb = enc.encode(b ?? "");
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function metricsAuthorized(req: Request, url: URL): { authorized: boolean; configured: boolean } {
  const expected = (Deno.env.get("WMS_METRICS_TOKEN") ?? "").trim();
  if (!expected) return { authorized: false, configured: false };

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const header = (req.headers.get("x-metrics-token") ?? "").trim();
  const query = (url.searchParams.get("token") ?? "").trim();

  return {
    authorized:
      timingSafeEqual(bearer, expected) ||
      timingSafeEqual(header, expected) ||
      timingSafeEqual(query, expected),
    configured: true,
  };
}

/** Block SSRF against loopback / link-local / metadata targets. */
function isSafeWebhookTarget(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const blocked = [
      "localhost",
      "0.0.0.0",
      "127.0.0.1",
      "::1",
      "metadata.google.internal",
      "169.254.169.254",
    ];
    if (blocked.includes(host)) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".internal")) return false;
    return true;
  } catch {
    return false;
  }
}

function json(data: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const verdict = evaluateOrigin(origin);
  const corsHeaders = verdict.headers;

  if (!verdict.allowed) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return json(
      {
        ok: false,
        error: `ORIGIN_NOT_ALLOWED: ${origin ?? "unknown"} is not in WMS_ALLOWED_ORIGINS`,
      },
      403,
      corsHeaders,
    );
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = performance.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "Edge runtime missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const latency = () => Math.round((performance.now() - startedAt) * 100) / 100;

  try {
    const action = (url.searchParams.get("action") || "health").trim();
    const tenantCode = (req.headers.get("x-tenant-code") || url.searchParams.get("tenant") || "").trim();
    const warehouseCode = (req.headers.get("x-warehouse-code") || url.searchParams.get("warehouse") || "").trim();
    const sessionToken = (req.headers.get("x-session-token") || "").trim();
    const deviceId = (req.headers.get("x-device-id") || "").trim();
    const rawBody = req.method === "POST" ? await req.text() : "";
    let body: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return json({ ok: false, error: "INVALID_JSON_PAYLOAD" }, 400, corsHeaders);
      }
    }

    const effectiveTenant = String((body?.tenant_code as string) || tenantCode || "").trim();
    const effectiveWarehouse = String((body?.warehouse_code as string) || warehouseCode || "").trim();

    // ---------------------------------------------------------------- health
    if (req.method === "GET" && action === "health") {
      const payload: Record<string, unknown> = {
        status: "healthy",
        service: "yesi-wms-edge-api",
        version: VERSION,
        warehouse: warehouseCode || "UNSCOPED",
        latency_ms: latency(),
        timestamp: new Date().toISOString(),
        security: {
          cors_mode: configuredOrigins().length > 0 ? "strict_allowlist" : "deny_all_browser_origins",
          allowed_origin_count: configuredOrigins().length,
          metrics_auth: (Deno.env.get("WMS_METRICS_TOKEN") ?? "").trim() ? "enabled" : "disabled",
          webhook_auth: (Deno.env.get("WMS_WEBHOOK_SECRET") ?? "").trim() ? "enabled" : "disabled",
        },
        kpis: null as unknown,
        error: null as string | null,
      };

      if (warehouseCode) {
        const { data, error } = await supabase
          .from("v_wms_kpi_summary")
          .select("*")
          .eq("warehouse_code", warehouseCode)
          .maybeSingle();
        payload.status = error || !data ? "degraded" : "healthy";
        payload.kpis = data ?? null;
        payload.error = error?.message ?? (data ? null : `Warehouse ${warehouseCode} not found`);
        payload.latency_ms = latency();
        if (error) return json(payload, 503, corsHeaders);
      }
      return json(payload, 200, corsHeaders);
    }

    // --------------------------------------------------------------- metrics
    if (req.method === "GET" && action === "metrics") {
      const auth = metricsAuthorized(req, url);
      if (!auth.configured) {
        return json(
          { ok: false, error: "METRICS_DISABLED: WMS_METRICS_TOKEN is not configured on this project" },
          503,
          corsHeaders,
        );
      }
      if (!auth.authorized) {
        return json({ ok: false, error: "METRICS_UNAUTHORIZED: valid WMS_METRICS_TOKEN required" }, 401, corsHeaders);
      }

      const { data: rows } = await supabase.from("v_wms_kpi_summary").select("*");
      const { data: outbox } = await supabase.rpc("wms_get_outbox_metrics", {
        p_tenant_code: effectiveTenant || null,
      });

      const lines: string[] = [
        "# HELP wms_inventory_on_hand_units Current physical stock on hand per warehouse",
        "# TYPE wms_inventory_on_hand_units gauge",
        "# HELP wms_inventory_available_units Unreserved allocatable stock per warehouse",
        "# TYPE wms_inventory_available_units gauge",
        "# HELP wms_inventory_quarantine_units Quarantined stock per warehouse",
        "# TYPE wms_inventory_quarantine_units gauge",
        "# HELP wms_active_bins Distinct bins holding stock per warehouse",
        "# TYPE wms_active_bins gauge",
        "# HELP wms_orders_open_total Open fulfillment orders in pipeline",
        "# TYPE wms_orders_open_total gauge",
        "# HELP wms_orders_shipped_total Dispatched orders (all time)",
        "# TYPE wms_orders_shipped_total counter",
        "# HELP wms_orders_shipped_today Orders dispatched since local midnight",
        "# TYPE wms_orders_shipped_today gauge",
        "# HELP wms_allocation_conflicts_total FEFO shortfalls and scan mismatches in 24h",
        "# TYPE wms_allocation_conflicts_total counter",
        "# HELP wms_sync_latency_ms_average Average client sync/RPC latency over 1h",
        "# TYPE wms_sync_latency_ms_average gauge",
        "# HELP wms_outbox_pending_events Unconfirmed transactional outbox events",
        "# TYPE wms_outbox_pending_events gauge",
        "# HELP wms_outbox_dead_letter_events Outbox events moved to the DLQ",
        "# TYPE wms_outbox_dead_letter_events gauge",
        "# HELP wms_edge_gateway_latency_ms Edge gateway request latency",
        "# TYPE wms_edge_gateway_latency_ms gauge",
      ];

      for (const r of rows ?? []) {
        const wh = r.warehouse_code;
        lines.push(`wms_inventory_on_hand_units{warehouse="${wh}"} ${r.total_on_hand ?? 0}`);
        lines.push(`wms_inventory_available_units{warehouse="${wh}"} ${r.total_available ?? 0}`);
        lines.push(`wms_inventory_quarantine_units{warehouse="${wh}"} ${r.quarantine_units ?? 0}`);
        lines.push(`wms_active_bins{warehouse="${wh}"} ${r.active_bins ?? 0}`);
        lines.push(`wms_orders_open_total{warehouse="${wh}"} ${r.open_orders ?? 0}`);
        lines.push(`wms_orders_shipped_total{warehouse="${wh}"} ${r.shipped_orders ?? 0}`);
        lines.push(`wms_orders_shipped_today{warehouse="${wh}"} ${r.shipped_today ?? 0}`);
        lines.push(`wms_allocation_conflicts_total{warehouse="${wh}"} ${r.allocation_conflicts ?? 0}`);
        lines.push(`wms_sync_latency_ms_average{warehouse="${wh}"} ${r.avg_sync_latency_ms ?? 0}`);
        lines.push(`wms_outbox_pending_events{warehouse="${wh}"} ${r.outbox_pending ?? 0}`);
        lines.push(`wms_outbox_dead_letter_events{warehouse="${wh}"} ${r.outbox_dead_letter ?? 0}`);
      }

      const ob = (outbox ?? {}) as Record<string, number>;
      for (const key of ["pending", "processing", "published", "failed", "dead_letter", "leased", "stale_leases"]) {
        lines.push(`# TYPE wms_outbox_${key}_total gauge`);
        lines.push(`wms_outbox_${key}_total ${ob[key] ?? 0}`);
      }
      lines.push(`wms_edge_gateway_latency_ms ${latency()}`);

      return new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain; version=0.0.4" },
      });
    }

    // ------------------------------------------------------- bootstrap status
    if (req.method === "GET" && action === "bootstrap_status") {
      const { data, error } = await supabase.rpc("wms_get_bootstrap_status", {
        p_tenant_code: effectiveTenant || null,
      });
      if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ------------------------------------------------------------- POST ops
    if (req.method === "POST") {
      if (!body || typeof body !== "object") {
        return json({ ok: false, error: "INVALID_JSON_PAYLOAD" }, 400, corsHeaders);
      }
      const op = String((body.action as string) || action || "").trim();

      if (!effectiveTenant || !effectiveWarehouse) {
        return json(
          {
            ok: false,
            error:
              "SCOPE_REQUIRED: Both tenant_code (x-tenant-code) and warehouse_code (x-warehouse-code) are mandatory on mutating API calls",
          },
          400,
          corsHeaders,
        );
      }

      const { data: tenantRow } = await supabase
        .from("wms_tenants")
        .select("id, code, status")
        .eq("code", effectiveTenant)
        .eq("status", "active")
        .maybeSingle();
      if (!tenantRow) return json({ ok: false, error: `TENANT_INVALID: ${effectiveTenant}` }, 403, corsHeaders);

      const { data: whRow } = await supabase
        .from("wms_warehouses")
        .select("id, tenant_id, code, status")
        .eq("tenant_id", tenantRow.id)
        .eq("code", effectiveWarehouse)
        .eq("status", "active")
        .maybeSingle();
      if (!whRow) {
        return json(
          { ok: false, error: `WAREHOUSE_INVALID: ${effectiveWarehouse} not active under ${effectiveTenant}` },
          403,
          corsHeaders,
        );
      }

      /** Validates the signed session and returns the operator record. */
      async function requireSession(roles: string[]) {
        if (!sessionToken) return { ok: false as const, status: 401, error: "AUTH_REQUIRED: signed x-session-token required" };
        const { data, error } = await supabase.rpc("wms_validate_session", {
          p_session_token: sessionToken,
          p_tenant_code: effectiveTenant,
          p_warehouse_code: effectiveWarehouse,
        });
        if (error || !data?.valid) {
          return { ok: false as const, status: 401, error: data?.error ?? error?.message ?? "SESSION_INVALID" };
        }
        const role = String(data.user?.role ?? "");
        if (roles.length > 0 && !roles.includes(role)) {
          return { ok: false as const, status: 403, error: `PERMISSION_DENIED: role ${role} cannot run ${op}` };
        }
        return { ok: true as const, user: data.user as Record<string, unknown> };
      }

      // ------------------------------------------- first-run admin bootstrap
      if (op === "bootstrap_admin") {
        const { data, error } = await supabase.rpc("wms_bootstrap_first_admin", {
          p_username: String(body.username ?? "").trim(),
          p_password: String(body.password ?? ""),
          p_tenant_code: effectiveTenant,
          p_display_name: body.display_name ? String(body.display_name) : null,
          p_email: body.email ? String(body.email) : null,
          p_warehouse_code: effectiveWarehouse,
          p_device_id: deviceId || null,
          p_user_agent: req.headers.get("user-agent"),
        });
        if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);
        const ok = Boolean(data?.authenticated);
        return json({ ...(data as object), latency_ms: latency() }, ok ? 200 : 400, corsHeaders);
      }

      // ---------------------------------------------- credential rotation
      if (op === "rotate_password") {
        const session = await requireSession([]);
        if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);
        const { data, error } = await supabase.rpc("wms_rotate_operator_password", {
          p_session_token: sessionToken,
          p_tenant_code: effectiveTenant,
          p_target_username: String(body.username ?? session.user?.username ?? "").trim(),
          p_new_password: String(body.new_password ?? ""),
          p_current_password: body.current_password ? String(body.current_password) : null,
          p_device_id: deviceId || null,
        });
        if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);
        return json({ ...(data as object), latency_ms: latency() }, data?.ok ? 200 : 400, corsHeaders);
      }

      // ------------------------------- server-authoritative lifecycle command
      if (op === "command" || op === "execute_command") {
        const session = await requireSession(["admin", "supervisor", "operator"]);
        if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);

        const command = String(body.command ?? "").trim();
        if (!command) return json({ ok: false, error: "COMMAND_REQUIRED" }, 400, corsHeaders);

        const { data, error } = await supabase.rpc("wms_execute_command", {
          p_command: command,
          p_payload: (body.payload as object) ?? {},
          p_idempotency_key: body.idempotency_key
            ? String(body.idempotency_key)
            : req.headers.get("x-idempotency-key") || null,
          p_tenant_code: effectiveTenant,
          p_warehouse_code: effectiveWarehouse,
          p_session_token: sessionToken,
          p_device_id: deviceId || null,
        });
        if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);
        return json({ ...(data as object), latency_ms: latency() }, data?.ok ? 200 : 409, corsHeaders);
      }

      // ------------------------------------------------------- telemetry batch
      if (op === "telemetry") {
        const session = await requireSession([]);
        if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);
        const batch = Array.isArray(body.events) ? body.events : [body.event ?? body].filter(Boolean);
        const { data, error } = await supabase.rpc("wms_record_telemetry", {
          p_batch: batch,
          p_tenant_code: effectiveTenant,
          p_warehouse_code: effectiveWarehouse,
          p_device_id: deviceId || null,
          p_session_id: sessionToken ? await hmacSha256Hex("wms-session", sessionToken).then((h) => h.slice(0, 16)) : null,
        });
        if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);
        return json({ ...(data as object), latency_ms: latency() }, 200, corsHeaders);
      }

      // ------------------------------------------------ outbox metrics / DLQ
      if (op === "outbox_metrics") {
        const session = await requireSession(["admin", "supervisor", "operator"]);
        if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);
        const { data, error } = await supabase.rpc("wms_get_outbox_metrics", { p_tenant_code: effectiveTenant });
        if (error) return json({ ok: false, error: error.message }, 500, corsHeaders);

        const { data: dlq } = await supabase
          .from("wms_event_outbox")
          .select("id, event_type, aggregate_id, retry_count, error_message, created_at, last_attempt_at")
          .eq("tenant_id", tenantRow.id)
          .in("status", ["failed", "dead_letter"])
          .order("created_at", { ascending: false })
          .range(0, 49);

        return json({ ...(data as object), dead_letter_queue: dlq ?? [], latency_ms: latency() }, 200, corsHeaders);
      }

      // ---------------------------------------------- REAL outbox delivery
      if (op === "flush_outbox") {
        const session = await requireSession(["admin", "supervisor", "operator"]);
        if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);

        const owner = `edge:${deviceId || "gateway"}:${crypto.randomUUID().slice(0, 8)}`;
        const batchLimit = Math.min(100, Math.max(1, Number(body.batch_limit ?? 25)));

        const { data: claim, error: claimErr } = await supabase.rpc("wms_claim_outbox_batch", {
          p_owner: owner,
          p_batch_limit: batchLimit,
          p_lease_seconds: 90,
          p_tenant_code: effectiveTenant,
          p_event_types: null,
        });
        if (claimErr) return json({ ok: false, error: claimErr.message }, 500, corsHeaders);

        const events = (claim?.events ?? []) as Array<Record<string, unknown>>;

        const { data: endpoints } = await supabase
          .from("wms_integration_endpoints")
          .select("id, name, endpoint_type, provider, config, status")
          .eq("tenant_id", tenantRow.id)
          .eq("status", "active");

        const targets = (endpoints ?? [])
          .map((e) => ({
            id: e.id as string,
            name: e.name as string,
            url: String((e.config as Record<string, unknown>)?.webhook_url ?? ""),
            secret: String((e.config as Record<string, unknown>)?.webhook_secret ?? ""),
          }))
          .filter((t) => t.url && isSafeWebhookTarget(t.url));

        const webhookSecret = (Deno.env.get("WMS_WEBHOOK_SECRET") ?? "").trim();
        let delivered = 0;
        let broadcast = 0;
        let failed = 0;
        let deadLettered = 0;
        const failures: Array<Record<string, unknown>> = [];

        for (const ev of events) {
          const eventId = ev.id as string;

          if (targets.length === 0) {
            // No HTTP subscribers configured: the event is still durably
            // published to Supabase Realtime by the database publication.
            await supabase.rpc("wms_complete_outbox_event", {
              p_event_id: eventId,
              p_status: "published",
              p_owner: owner,
              p_error: null,
              p_endpoint: "supabase-realtime",
              p_response_code: 200,
            });
            broadcast++;
            continue;
          }

          let eventOk = true;
          for (const t of targets) {
            const payload = JSON.stringify({
              event_id: ev.idempotency_key ?? eventId,
              event_type: ev.event_type,
              aggregate: { type: ev.aggregate_type, id: ev.aggregate_id },
              tenant: effectiveTenant,
              warehouse: effectiveWarehouse,
              occurred_at: ev.created_at,
              data: ev.payload,
            });
            const signWith = t.secret || webhookSecret;
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              "X-Yesi-Event": String(ev.event_type ?? ""),
              "X-Yesi-Delivery": eventId,
            };
            if (signWith) headers["X-Yesi-Signature"] = `sha256=${await hmacSha256Hex(signWith, payload)}`;

            try {
              const res = await fetch(t.url, {
                method: "POST",
                headers,
                body: payload,
                signal: AbortSignal.timeout(8000),
              });
              await supabase.rpc("wms_complete_outbox_event", {
                p_event_id: eventId,
                p_status: res.ok ? "published" : "failed",
                p_owner: owner,
                p_error: res.ok ? null : `HTTP ${res.status} from ${t.name}`,
                p_endpoint: t.name,
                p_response_code: res.status,
              });
              if (res.ok) delivered++;
              else {
                eventOk = false;
                failed++;
                failures.push({ endpoint: t.name, status: res.status, event_type: ev.event_type });
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await supabase.rpc("wms_complete_outbox_event", {
                p_event_id: eventId,
                p_status: "failed",
                p_owner: owner,
                p_error: message.slice(0, 200),
                p_endpoint: t.name,
                p_response_code: null,
              });
              eventOk = false;
              failed++;
              failures.push({ endpoint: t.name, error: message.slice(0, 200), event_type: ev.event_type });
            }
          }
          if (!eventOk && Number(ev.retry_count ?? 0) + 1 >= 8) deadLettered++;
        }

        await supabase.from("wms_audit_logs").insert({
          tenant_id: tenantRow.id,
          warehouse_id: whRow.id,
          operator_name: String(session.user?.username ?? "api"),
          action: "OUTBOX_FLUSHED",
          entity_type: "wms_event_outbox",
          details: `claimed=${events.length} delivered=${delivered} broadcast=${broadcast} failed=${failed} targets=${targets.length}`,
        });

        return json(
          {
            ok: true,
            owner,
            warehouse: effectiveWarehouse,
            claimed: events.length,
            delivered,
            broadcast,
            failed,
            dead_lettered: deadLettered,
            http_targets: targets.map((t) => t.name),
            failures: failures.slice(0, 10),
            latency_ms: latency(),
          },
          200,
          corsHeaders,
        );
      }

      // -------------------------------------------------- marketplace webhook
      if (op === "webhook_order") {
        const expectedSecret = (Deno.env.get("WMS_WEBHOOK_SECRET") ?? "").trim();
        const providedSecret = (req.headers.get("x-webhook-secret") ?? "").trim();
        const signature = (req.headers.get("x-yesi-signature") ?? "").trim();

        if (!expectedSecret) {
          return json(
            {
              ok: false,
              error: "WEBHOOK_DISABLED: WMS_WEBHOOK_SECRET is not configured; refusing unauthenticated ingestion",
            },
            503,
            corsHeaders,
          );
        }

        const signatureOk = signature
          ? timingSafeEqual(signature.replace(/^sha256=/i, ""), await hmacSha256Hex(expectedSecret, rawBody))
          : false;
        const secretOk = timingSafeEqual(providedSecret, expectedSecret);

        let authorizedActor = String(body.source || "marketplace");
        if (!signatureOk && !secretOk) {
          // Fall back to a supervisor/admin session for internal integrations.
          if (!sessionToken) {
            return json(
              { ok: false, error: "WEBHOOK_UNAUTHORIZED: provide x-yesi-signature (HMAC-SHA256) or x-webhook-secret" },
              401,
              corsHeaders,
            );
          }
          const session = await requireSession(["admin", "supervisor"]);
          if (!session.ok) return json({ ok: false, error: session.error }, session.status, corsHeaders);
          authorizedActor = String(session.user?.username ?? "operator");
        }

        const orderNumber = String(body.order_number || "").trim();
        const requiredSkus = String(body.required_skus || "").trim();
        if (!orderNumber || !requiredSkus) {
          return json(
            { ok: false, error: "VALIDATION_ERROR: order_number and required_skus are required" },
            422,
            corsHeaders,
          );
        }

        const source = String(body.source || authorizedActor || "marketplace").slice(0, 60);
        const eventId = String(
          req.headers.get("x-idempotency-key") || body.event_id || `ord:${effectiveWarehouse}:${orderNumber}`,
        ).slice(0, 160);

        // Database-side deduplication: a repeated provider event is a no-op.
        const { data: ingest, error: ingestErr } = await supabase.rpc("wms_ingest_webhook", {
          p_source: source,
          p_event_id: eventId,
          p_event_type: String(body.event_type || "ORDER_CREATED"),
          p_payload: body,
          p_tenant_code: effectiveTenant,
          p_warehouse_code: effectiveWarehouse,
        });
        if (ingestErr) return json({ ok: false, error: ingestErr.message }, 500, corsHeaders);

        if (ingest?.deduplicated) {
          return json(
            {
              ok: true,
              deduplicated: true,
              event_id: eventId,
              order_number: orderNumber,
              message: "Event already ingested; no side effects applied",
              latency_ms: latency(),
            },
            200,
            corsHeaders,
          );
        }

        const { error: orderErr } = await supabase.from("wms_sales_orders").upsert(
          {
            tenant_id: tenantRow.id,
            warehouse_id: whRow.id,
            order_number: orderNumber,
            posting_number: String(body.posting_number || orderNumber),
            channel: String(body.channel || "ozon"),
            status: "Pending",
            priority: ["urgent", "high", "normal"].includes(String(body.priority)) ? String(body.priority) : "normal",
            required_skus: requiredSkus,
            lines: requiredSkus
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((sku) => ({ sku, qty: 1 })),
            total_amount: Math.max(0, Number(body.total_amount || 0)),
            carrier_name: String(body.carrier_name || "GBS Express"),
            tracking_number: String(body.tracking_number || orderNumber),
          },
          { onConflict: "warehouse_id,order_number" },
        );
        if (orderErr) return json({ ok: false, error: orderErr.message }, 500, corsHeaders);

        await supabase.from("wms_audit_logs").insert({
          tenant_id: tenantRow.id,
          warehouse_id: whRow.id,
          operator_name: authorizedActor,
          action: "WEBHOOK_ORDER_INGESTED",
          entity_type: "wms_sales_orders",
          entity_id: orderNumber,
          details: `Ingested order ${orderNumber} (${requiredSkus}) via ${source}`,
        });

        return json(
          { ok: true, deduplicated: false, event_id: eventId, order_number: orderNumber, latency_ms: latency() },
          200,
          corsHeaders,
        );
      }

      return json({ ok: false, error: `Unsupported POST action: ${op}` }, 400, corsHeaders);
    }

    return json({ ok: false, error: `Unsupported action: ${action}` }, 400, corsHeaders);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
      corsHeaders,
    );
  }
});
