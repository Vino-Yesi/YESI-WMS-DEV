/**
 * Thin hook for a future HPC / cloud “deep optimize” service.
 *
 * Offline-first: export a job payload, later import a result plan.
 * No network calls yet — import validates shape and returns a plan
 * the UI can apply (same as local Quantum route).
 */

import { db, logAction } from './db';

export const DEEP_OPTIMIZE_SCHEMA = 1 as const;

export type DeepOptimizeJob = {
  schema: typeof DEEP_OPTIMIZE_SCHEMA;
  jobId: string;
  createdAt: string;
  operator: string;
  waveName: string;
  /** Ordered tracking / SKU keys to optimize */
  items: Array<{
    trackingId: string;
    product: string;
    qty: number;
    sku?: string;
  }>;
  meta?: {
    source: 'daily-manual' | 'batch-pick' | 'api';
    note?: string;
  };
};

export type DeepOptimizeResult = {
  schema: typeof DEEP_OPTIMIZE_SCHEMA;
  jobId: string;
  completedAt: string;
  engine: 'local-worker' | 'hpc' | 'quantum-cloud' | 'import';
  /** Suggested order of tracking IDs or SKUs */
  orderedKeys: string[];
  metrics?: {
    totalDistance?: number;
    estimatedMinutes?: number;
    improvementPct?: number;
  };
  notes?: string;
};

const PREF_LAST_JOB = 'deep_optimize_last_job';
const PREF_LAST_RESULT = 'deep_optimize_last_result';

function jobId(): string {
  return `deep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildDeepOptimizeJob(
  items: DeepOptimizeJob['items'],
  operator: string,
  waveName: string,
  note?: string,
): DeepOptimizeJob {
  return {
    schema: DEEP_OPTIMIZE_SCHEMA,
    jobId: jobId(),
    createdAt: new Date().toISOString(),
    operator,
    waveName,
    items,
    meta: { source: 'daily-manual', note },
  };
}

/** Downloadable JSON for an external HPC pipeline */
export function exportDeepOptimizeJob(job: DeepOptimizeJob): Blob {
  return new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
}

export function downloadDeepOptimizeJob(job: DeepOptimizeJob, filename?: string) {
  const blob = exportDeepOptimizeJob(job);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `yesi-deep-optimize-${job.jobId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseDeepOptimizeResult(raw: unknown): DeepOptimizeResult {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('Invalid deep optimize result');
  const r = data as DeepOptimizeResult & { schema?: unknown };
  if (r.schema !== DEEP_OPTIMIZE_SCHEMA) throw new Error(`Unsupported schema ${String(r.schema)}`);
  if (!Array.isArray(r.orderedKeys) || r.orderedKeys.length === 0) {
    throw new Error('Result must include non-empty orderedKeys');
  }
  if (!r.jobId) throw new Error('Result missing jobId');
  return {
    schema: DEEP_OPTIMIZE_SCHEMA,
    jobId: r.jobId,
    completedAt: r.completedAt || new Date().toISOString(),
    engine: r.engine || 'import',
    orderedKeys: r.orderedKeys.map(String),
    metrics: r.metrics,
    notes: r.notes,
  };
}

export async function persistDeepOptimizeJob(job: DeepOptimizeJob, operator: string) {
  const serialized = JSON.stringify(job);
  const existing = await db.preferences.where('key').equals(PREF_LAST_JOB).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: serialized, createdAt: job.createdAt });
  } else {
    await db.preferences.add({ key: PREF_LAST_JOB, value: serialized, createdAt: job.createdAt });
  }
  await logAction('DEEP_OPTIMIZE_EXPORT', `job=${job.jobId} items=${job.items.length}`, operator);
}

export async function persistDeepOptimizeResult(result: DeepOptimizeResult, operator: string) {
  const serialized = JSON.stringify(result);
  const existing = await db.preferences.where('key').equals(PREF_LAST_RESULT).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: serialized, createdAt: result.completedAt });
  } else {
    await db.preferences.add({
      key: PREF_LAST_RESULT,
      value: serialized,
      createdAt: result.completedAt,
    });
  }
  await logAction(
    'DEEP_OPTIMIZE_IMPORT',
    `job=${result.jobId} engine=${result.engine} keys=${result.orderedKeys.length}`,
    operator,
  );
}

/**
 * Reorder posting rows by imported orderedKeys (trackingId or sku/product match).
 */
export function applyDeepOptimizeOrder<T extends { trackingId: string; product: string; sku?: string }>(
  rows: T[],
  orderedKeys: string[],
): T[] {
  const order = new Map(orderedKeys.map((k, i) => [k, i]));
  const rank = (r: T) => {
    for (const key of [r.trackingId, r.sku, r.product]) {
      if (key && order.has(key)) return order.get(key)!;
    }
    return 1e9;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** Placeholder for future POST to HPC — currently no-op that documents the contract */
export async function submitDeepOptimizeToHpc(job: DeepOptimizeJob): Promise<{ accepted: false; reason: string }> {
  void job;
  return {
    accepted: false,
    reason: 'HPC endpoint not configured. Export JSON and import the result when ready.',
  };
}
