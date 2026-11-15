/**
 * Main-thread client for src/workers/compute.worker.ts
 */

import type { WorkerResponse, RoutePointMsg, ForecastMsg } from '@/workers/compute.worker';

export type { RoutePointMsg, ForecastMsg };

/** Request payloads without id (discriminated union kept intact) */
type WorkerRequestPayload =
  | { type: 'OPTIMIZE_ROUTE'; skus: string[] }
  | { type: 'FORECAST'; sku: string; baseStock: number; days?: number }
  | {
      type: 'OPTIMIZE_AND_FORECAST';
      skus: string[];
      forecastSku: string;
      baseStock: number;
      days?: number;
    };

type Pending = {
  resolve: (v: WorkerResponse) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<string, Pending>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      p.resolve(data);
    };
    worker.onerror = (err) => {
      console.error('[compute.worker]', err);
    };
  } catch (e) {
    console.warn('[computeClient] Worker unavailable', e);
    worker = null;
  }
  return worker;
}

function call(req: WorkerRequestPayload, timeoutMs = 20000): Promise<WorkerResponse> {
  const id = `w_${++seq}_${Date.now()}`;
  const w = getWorker();
  if (!w) {
    return Promise.reject(new Error('Web Worker not available in this environment'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Compute worker timeout'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ ...req, id });
  });
}

export async function workerOptimizeRoute(skus: string[]): Promise<{ route: RoutePointMsg[]; ms: number }> {
  const res = await call({ type: 'OPTIMIZE_ROUTE', skus });
  if (!res.ok || res.type !== 'OPTIMIZE_ROUTE') {
    throw new Error(!res.ok ? res.error : 'Unexpected worker response');
  }
  return { route: res.route, ms: res.ms };
}

export async function workerForecast(
  sku: string,
  baseStock: number,
  days = 7,
): Promise<{ result: ForecastMsg; ms: number }> {
  const res = await call({ type: 'FORECAST', sku, baseStock, days });
  if (!res.ok || res.type !== 'FORECAST') {
    throw new Error(!res.ok ? res.error : 'Unexpected worker response');
  }
  return { result: res.result, ms: res.ms };
}

export async function workerOptimizeAndForecast(
  skus: string[],
  forecastSku: string,
  baseStock: number,
  days = 7,
): Promise<{ route: RoutePointMsg[]; result: ForecastMsg; ms: number }> {
  const res = await call({ type: 'OPTIMIZE_AND_FORECAST', skus, forecastSku, baseStock, days });
  if (!res.ok || res.type !== 'OPTIMIZE_AND_FORECAST') {
    throw new Error(!res.ok ? res.error : 'Unexpected worker response');
  }
  return { route: res.route, result: res.result, ms: res.ms };
}

export function terminateComputeWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pending.clear();
}
