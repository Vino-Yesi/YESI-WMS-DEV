/**
 * Local heavy compute off main thread (route TSP + simple forecast).
 * No Dexie / DOM — only numeric algorithms.
 */

export type WorkerRequest =
  | { id: string; type: 'OPTIMIZE_ROUTE'; skus: string[] }
  | { id: string; type: 'FORECAST'; sku: string; baseStock: number; days?: number }
  | { id: string; type: 'OPTIMIZE_AND_FORECAST'; skus: string[]; forecastSku: string; baseStock: number; days?: number };

export type RoutePointMsg = { sku: string; zone: string; x: number; y: number };

export type ForecastMsg = {
  sku: string;
  forecast: number[];
  recommendedReorder: number;
  stockoutRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence: number;
  trend: 'DECLINING' | 'STABLE' | 'RISING';
  avgDailyOrders: number;
};

export type WorkerResponse =
  | { id: string; type: 'OPTIMIZE_ROUTE'; ok: true; route: RoutePointMsg[]; ms: number }
  | { id: string; type: 'FORECAST'; ok: true; result: ForecastMsg; ms: number }
  | {
      id: string;
      type: 'OPTIMIZE_AND_FORECAST';
      ok: true;
      route: RoutePointMsg[];
      result: ForecastMsg;
      ms: number;
    }
  | { id: string; type: string; ok: false; error: string };

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildZones(gridW = 24, gridH = 16) {
  const zones: Record<string, { x: number; y: number }> = {};
  const letters = 'ABCDEFGH';
  for (const l of letters) {
    for (let n = 1; n <= 3; n++) {
      const name = `${l}${n}`;
      zones[name] = {
        x: (fnv1a(name) & 0xff) % (gridW - 3) + 2,
        y: ((fnv1a(name) >>> 8) & 0xff) % (gridH - 3) + 2,
      };
    }
  }
  return zones;
}

const ZONES = buildZones();

function zoneForSku(sku: string): string {
  const keys = Object.keys(ZONES);
  return keys[fnv1a(sku) % keys.length];
}

function dist(a: RoutePointMsg, b: RoutePointMsg): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function optimizeRoute(skuList: string[]): RoutePointMsg[] {
  if (skuList.length === 0) return [];
  const points: RoutePointMsg[] = skuList.map((sku) => {
    const zone = zoneForSku(sku);
    const z = ZONES[zone];
    return { sku, zone, x: z.x, y: z.y };
  });
  const route: RoutePointMsg[] = [points[0]];
  const remaining = points.slice(1);
  while (remaining.length > 0) {
    const current = route[route.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    route.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  // 2-opt
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 120) {
    improved = false;
    iterations += 1;
    for (let i = 1; i < route.length - 2; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const a = route[i - 1];
        const b = route[i];
        const c = route[j];
        const d = j + 1 < route.length ? route[j + 1] : null;
        const before = dist(a, b) + (d ? dist(c, d) : 0);
        const after = dist(a, c) + (d ? dist(b, d) : 0);
        if (after + 1e-9 < before) {
          const segment = route.slice(i, j + 1).reverse();
          route.splice(i, j - i + 1, ...segment);
          improved = true;
        }
      }
    }
  }
  return route;
}

function forecast(sku: string, baseStock: number, days = 7): ForecastMsg {
  const history: number[] = [];
  let stock = Math.max(0, baseStock);
  for (let i = 0; i < 30; i++) {
    const noise = (fnv1a(`${sku}-${i}`) % 100) / 100;
    const demand = 2 + noise * 8;
    stock = Math.max(0, stock - demand + (noise > 0.85 ? 15 : 0));
    history.push(stock);
  }
  const alpha = 0.35;
  const beta = 0.15;
  let level = history[0] ?? baseStock;
  let trend = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = level;
    level = alpha * history[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  const series: number[] = [];
  for (let d = 1; d <= days; d++) {
    series.push(Math.max(0, level + d * trend));
  }
  const avgDaily = Math.abs(trend) + 3;
  const end = series[series.length - 1] ?? 0;
  const stockoutRisk: ForecastMsg['stockoutRisk'] =
    end < avgDaily * 2 ? 'HIGH' : end < avgDaily * 5 ? 'MEDIUM' : 'LOW';
  const trendDir: ForecastMsg['trend'] =
    trend < -0.5 ? 'DECLINING' : trend > 0.5 ? 'RISING' : 'STABLE';
  const recommendedReorder = Math.max(0, Math.ceil(avgDaily * 14 - end));
  return {
    sku,
    forecast: series.map((n) => Math.round(n * 10) / 10),
    recommendedReorder,
    stockoutRisk,
    confidence: 0.62,
    trend: trendDir,
    avgDailyOrders: Math.round(avgDaily * 10) / 10,
  };
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    if (msg.type === 'OPTIMIZE_ROUTE') {
      const route = optimizeRoute(msg.skus || []);
      const res: WorkerResponse = {
        id: msg.id,
        type: 'OPTIMIZE_ROUTE',
        ok: true,
        route,
        ms: Math.round(performance.now() - t0),
      };
      self.postMessage(res);
      return;
    }
    if (msg.type === 'FORECAST') {
      const result = forecast(msg.sku, msg.baseStock, msg.days ?? 7);
      const res: WorkerResponse = {
        id: msg.id,
        type: 'FORECAST',
        ok: true,
        result,
        ms: Math.round(performance.now() - t0),
      };
      self.postMessage(res);
      return;
    }
    if (msg.type === 'OPTIMIZE_AND_FORECAST') {
      const route = optimizeRoute(msg.skus || []);
      const result = forecast(msg.forecastSku, msg.baseStock, msg.days ?? 7);
      const res: WorkerResponse = {
        id: msg.id,
        type: 'OPTIMIZE_AND_FORECAST',
        ok: true,
        route,
        result,
        ms: Math.round(performance.now() - t0),
      };
      self.postMessage(res);
      return;
    }
    const fallback = msg as { id?: string; type?: string };
    self.postMessage({ id: fallback.id || '', type: fallback.type || 'UNKNOWN', ok: false, error: 'Unknown type' });
  } catch (e) {
    const fallback = msg as { id?: string; type?: string };
    self.postMessage({
      id: fallback.id || '',
      type: fallback.type || 'ERROR',
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};

export {};
