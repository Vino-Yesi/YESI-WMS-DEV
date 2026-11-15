/**
 * Versioned, operator-scoped Daily Manual session persistence.
 * IndexedDB (Dexie preferences) + sessionStorage + BroadcastChannel multi-tab awareness.
 */

import { db } from './db';

export const WORKFLOW_SESSION_VERSION = 1 as const;

export type WorkflowSessionV1 = {
  v: typeof WORKFLOW_SESSION_VERSION;
  operator: string;
  step: 1 | 2 | 3 | 4 | 5;
  rows: Array<{ trackingId: string; product: string; qty: number; sku?: string }>;
  fileName: string;
  assembled: string[];
  actualPaste: string;
  auditRows: unknown[];
  scanEvents: unknown[];
  shippedBatches: string[];
  orderRemarks: Record<string, string>;
  receivedAt: string | null;
  productSort: 'none' | 'asc' | 'desc' | 'group';
  savedAt: string;
  tabId: string;
};

export type WorkflowSession = WorkflowSessionV1;

const LEGACY_KEY = 'daily_manual_session';
const CHANNEL_NAME = 'yesi-wms-workflow-session';

function sessionKey(operator: string): string {
  const op = (operator || 'anonymous').trim().toLowerCase().replace(/\s+/g, '_');
  return `daily_manual:${op}`;
}

/** Stable per-tab id for multi-tab last-writer awareness */
export function getTabId(): string {
  try {
    let id = sessionStorage.getItem('yesi_tab_id');
    if (!id) {
      id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('yesi_tab_id', id);
    }
    return id;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function safeParse(raw: unknown): WorkflowSession | null {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    const rec = data as Record<string, unknown>;
    // Migrate legacy (no v field)
    if (rec.v == null && Array.isArray(rec.rows)) {
      return {
        v: 1,
        operator: (rec.operator as string) || 'anonymous',
        step: (rec.step as 1 | 2 | 3 | 4 | 5) || 1,
        rows: (rec.rows as WorkflowSession['rows']) || [],
        fileName: (rec.fileName as string) || '',
        assembled: (rec.assembled as string[]) || [],
        actualPaste: (rec.actualPaste as string) || '',
        auditRows: (rec.auditRows as unknown[]) || [],
        scanEvents: ((rec.scanEvents as unknown[]) || []).slice(0, 200),
        shippedBatches: (rec.shippedBatches as string[]) || [],
        orderRemarks: (rec.orderRemarks as Record<string, string>) || {},
        receivedAt: (rec.receivedAt as string | null) ?? null,
        productSort: (rec.productSort as WorkflowSession['productSort']) || 'none',
        savedAt: (rec.savedAt as string) || new Date().toISOString(),
        tabId: (rec.tabId as string) || getTabId(),
      };
    }
    if ((data as WorkflowSession).v !== WORKFLOW_SESSION_VERSION) return null;
    if (!Array.isArray((data as WorkflowSession).rows)) return null;
    return data as WorkflowSession;
  } catch {
    return null;
  }
}

export async function loadWorkflowSession(operator: string): Promise<WorkflowSession | null> {
  const key = sessionKey(operator);
  try {
    const pref = await db.preferences.where('key').equals(key).first();
    const fromDb = safeParse(pref?.value);
    if (fromDb?.rows?.length) return fromDb;

    // Legacy global key migration
    const legacyPref = await db.preferences.where('key').equals(LEGACY_KEY).first();
    const fromLegacy = safeParse(legacyPref?.value);
    if (fromLegacy?.rows?.length) {
      fromLegacy.operator = operator;
      fromLegacy.v = 1;
      await saveWorkflowSession(fromLegacy);
      return fromLegacy;
    }

    const ss = sessionStorage.getItem(key) || sessionStorage.getItem(LEGACY_KEY);
    return safeParse(ss);
  } catch {
    try {
      return safeParse(sessionStorage.getItem(key));
    } catch {
      return null;
    }
  }
}

export async function saveWorkflowSession(session: WorkflowSession): Promise<void> {
  const key = sessionKey(session.operator);
  const payload: WorkflowSession = {
    ...session,
    v: WORKFLOW_SESSION_VERSION,
    scanEvents: (session.scanEvents || []).slice(0, 200),
    savedAt: new Date().toISOString(),
    tabId: session.tabId || getTabId(),
  };
  const serialized = JSON.stringify(payload);
  try {
    sessionStorage.setItem(key, serialized);
  } catch {
    /* private mode / quota */
  }
  try {
    const existing = await db.preferences.where('key').equals(key).first();
    if (existing?.id != null) {
      await db.preferences.update(existing.id, {
        value: serialized,
        createdAt: payload.savedAt,
      });
    } else {
      await db.preferences.add({
        key,
        value: serialized,
        createdAt: payload.savedAt,
      });
    }
  } catch {
    /* quota */
  }
  // Notify other tabs
  try {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.postMessage({ type: 'session-saved', key, savedAt: payload.savedAt, tabId: payload.tabId, operator: payload.operator });
    bc.close();
  } catch {
    /* unsupported */
  }
}

export async function clearWorkflowSession(operator: string): Promise<void> {
  const key = sessionKey(operator);
  try {
    sessionStorage.removeItem(key);
    sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  try {
    const existing = await db.preferences.where('key').equals(key).first();
    if (existing?.id != null) await db.preferences.delete(existing.id);
    const legacy = await db.preferences.where('key').equals(LEGACY_KEY).first();
    if (legacy?.id != null) await db.preferences.delete(legacy.id);
  } catch {
    /* ignore */
  }
  try {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.postMessage({ type: 'session-cleared', key, operator });
    bc.close();
  } catch {
    /* ignore */
  }
}

export type SessionBroadcast =
  | { type: 'session-saved'; key: string; savedAt: string; tabId: string; operator: string }
  | { type: 'session-cleared'; key: string; operator: string };

/** Subscribe to multi-tab session events. Returns unsubscribe. */
export function subscribeSessionChannel(
  operator: string,
  onEvent: (ev: SessionBroadcast) => void,
): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL_NAME);
    bc.onmessage = (msg) => {
      const data = msg.data as SessionBroadcast;
      if (!data?.type) return;
      if (data.operator && data.operator !== operator && data.operator !== 'anonymous') return;
      onEvent(data);
    };
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      bc?.close();
    } catch {
      /* ignore */
    }
  };
}

export function formatSavedAgo(savedAt: string | null | undefined): string {
  if (!savedAt) return 'Not saved';
  const t = new Date(savedAt).getTime();
  if (Number.isNaN(t)) return 'Not saved';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 5) return 'Saved just now';
  if (sec < 60) return `Saved ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Saved ${min}m ago`;
  return `Saved ${new Date(savedAt).toLocaleTimeString()}`;
}
