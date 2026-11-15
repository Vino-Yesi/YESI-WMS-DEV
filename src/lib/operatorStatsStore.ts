/**
 * Persist OperatorStats (XP / level / badges) per operator in Dexie preferences.
 */

import { db } from './db';
import {
  createOperatorStats,
  addXp,
  type OperatorStats,
  type OperatorActionType,
} from './neuralOps';

function statsKey(username: string): string {
  return `operator_stats:${(username || 'anonymous').trim().toLowerCase()}`;
}

export async function loadOperatorStats(username: string): Promise<OperatorStats> {
  try {
    const pref = await db.preferences.where('key').equals(statsKey(username)).first();
    if (pref?.value) {
      const raw = typeof pref.value === 'string' ? JSON.parse(pref.value) : pref.value;
      if (raw && typeof raw.xp === 'number') {
        return {
          username: raw.username || username,
          xp: raw.xp ?? 0,
          level: raw.level ?? 1,
          picks: raw.picks ?? 0,
          audits: raw.audits ?? 0,
          scans: raw.scans ?? 0,
          accuracy: raw.accuracy ?? 100,
          streak: raw.streak ?? 0,
          badges: Array.isArray(raw.badges) ? raw.badges : [],
        };
      }
    }
  } catch {
    /* ignore */
  }
  return createOperatorStats(username);
}

export async function saveOperatorStats(stats: OperatorStats): Promise<void> {
  const key = statsKey(stats.username);
  const serialized = JSON.stringify(stats);
  try {
    const existing = await db.preferences.where('key').equals(key).first();
    if (existing?.id != null) {
      await db.preferences.update(existing.id, { value: serialized, createdAt: new Date().toISOString() });
    } else {
      await db.preferences.add({
        key,
        value: serialized,
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    /* quota */
  }
  try {
    const bc = new BroadcastChannel('yesi-wms-operator-stats');
    bc.postMessage({ type: 'stats-updated', username: stats.username, stats });
    bc.close();
  } catch {
    /* ignore */
  }
}

export async function awardXp(
  username: string,
  amount: number,
  actionType: OperatorActionType,
  accuracySample?: number,
): Promise<OperatorStats> {
  const stats = await loadOperatorStats(username);
  if (typeof accuracySample === 'number' && accuracySample >= 0) {
    // Running accuracy blend
    const n = stats.picks + stats.audits + stats.scans + 1;
    stats.accuracy = Math.round(((stats.accuracy * (n - 1) + accuracySample) / n) * 10) / 10;
  }
  const next = addXp(stats, amount, actionType);
  await saveOperatorStats(next);
  return next;
}

export function subscribeOperatorStats(
  username: string,
  onUpdate: (stats: OperatorStats) => void,
): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel('yesi-wms-operator-stats');
    bc.onmessage = (msg) => {
      if (msg.data?.type === 'stats-updated' && msg.data.username === username && msg.data.stats) {
        onUpdate(msg.data.stats as OperatorStats);
      }
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
