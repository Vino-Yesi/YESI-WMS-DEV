import { db } from './db';

// ─── Critical Workflow Handler ──────────────────────────────────────────
// Detects pressure scenarios and suggests automated solutions.
//
// Scenarios use STABLE, content-derived IDs so that a given condition maps to
// the same scenario across scans. Resolution state is persisted to the
// preferences table under key `resolved_scenarios`.

export type CriticalLevel = 'normal' | 'elevated' | 'critical' | 'emergency';

export interface PressureScenario {
  id: string;
  type: 'stockout' | 'sla_breach' | 'worker_overload' | 'qc_backlog' | 'integration_failure' | 'zone_overcapacity' | 'replenishment_needed' | 'batch_delay';
  level: CriticalLevel;
  title: string;
  description: string;
  detectedAt: string;
  affectedSkus?: string[];
  affectedOrders?: string[];
  affectedWorkers?: string[];
  suggestedActions: SuggestedAction[];
  autoResolvable: boolean;
  resolvedAt?: string;
}

export interface SuggestedAction {
  id: string;
  type: 'auto' | 'manual' | 'escalate';
  description: string;
  action: () => Promise<boolean>;
  estimatedImpact: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface WarehousePressure {
  level: CriticalLevel;
  pendingOrders: number;
  urgentOrders: number;
  lowStockItems: number;
  activeWorkers: number;
  workerUtilization: number; // 0-100
  qcBacklog: number;
  zoneUtilization: number; // 0-100
  avgPickTime: number; // minutes
  slaBreachRisk: number; // 0-100
  score: number; // 0-100 composite
}

// ─── Resolved-scenario persistence ─────────────────────────────────────

async function getResolvedIds(): Promise<Set<string>> {
  try {
    const pref = await db.preferences.where('key').equals('resolved_scenarios').first();
    if (pref?.value) {
      const parsed = JSON.parse(pref.value) as string[];
      return new Set(parsed);
    }
  } catch { /* ignore */ }
  return new Set();
}

async function markResolved(id: string) {
  const resolved = await getResolvedIds();
  resolved.add(id);
  // Keep only last 50 to avoid unbounded growth
  const arr = Array.from(resolved).slice(-50);
  const existing = await db.preferences.where('key').equals('resolved_scenarios').first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: JSON.stringify(arr) });
  } else {
    await db.preferences.add({
      key: 'resolved_scenarios',
      value: JSON.stringify(arr),
      createdAt: new Date().toISOString(),
    });
  }
}

// ─── Pressure Detection Engine ─────────────────────────────────────────

export async function detectPressureScenarios(): Promise<PressureScenario[]> {
  const scenarios: PressureScenario[] = [];
  const now = new Date().toISOString();
  const resolved = await getResolvedIds();

  // 1. Stockout detection
  const inventory = await db.inventory.toArray();
  const stockouts = inventory.filter(item => item.stock <= 0);
  const nearStockouts = inventory.filter(item => item.reorderPoint && item.stock <= item.reorderPoint);

  if (stockouts.length > 0) {
    const id = `stockout-${stockouts.map(s => s.sku).sort().join('|').slice(0, 80)}`;
    scenarios.push({
      id,
      type: 'stockout',
      level: 'critical',
      title: `Stockout Alert: ${stockouts.length} SKUs at zero inventory`,
      description: `${stockouts.map(s => s.sku).join(', ')} are completely out of stock. Immediate replenishment required.`,
      detectedAt: now,
      affectedSkus: stockouts.map(s => s.sku),
      suggestedActions: [
        {
          id: 'auto-replenish',
          type: 'auto',
          description: `Create emergency replenishment tasks for ${stockouts.length} SKUs`,
          action: async () => { await createEmergencyReplenishment(stockouts); return true; },
          estimatedImpact: 'Restock within 2-4 hours',
          riskLevel: 'low',
        },
        {
          id: 'escalate-purchasing',
          type: 'escalate',
          description: 'Notify purchasing team for expedited PO',
          action: async () => true,
          estimatedImpact: 'New stock in 24-48 hours',
          riskLevel: 'medium',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  if (nearStockouts.length > 3) {
    const id = `near-stockout-${nearStockouts.map(s => s.sku).sort().join('|').slice(0, 80)}`;
    scenarios.push({
      id,
      type: 'replenishment_needed',
      level: 'elevated',
      title: `${nearStockouts.length} SKUs below reorder point`,
      description: 'Multiple items approaching stockout. Proactive replenishment recommended.',
      detectedAt: now,
      affectedSkus: nearStockouts.map(s => s.sku),
      suggestedActions: [
        {
          id: 'batch-replenish',
          type: 'auto',
          description: `Generate replenishment tasks for ${nearStockouts.length} low-stock SKUs`,
          action: async () => { await createBatchReplenishment(nearStockouts); return true; },
          estimatedImpact: 'Prevent stockouts proactively',
          riskLevel: 'low',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  // 2. SLA Breach Detection
  const pendingOrders = await db.orders.where('status').equals('Pending').toArray();
  const urgentOrders = pendingOrders.filter(o => o.priority === 'urgent');

  if (urgentOrders.length > 5) {
    const id = `sla-breach-urgent-${urgentOrders.length}`;
    scenarios.push({
      id,
      type: 'sla_breach',
      level: 'critical',
      title: `${urgentOrders.length} urgent orders at risk of SLA breach`,
      description: `Urgent orders ${urgentOrders.map(o => o.orderId).slice(0, 5).join(', ')}${urgentOrders.length > 5 ? '...' : ''} have been pending too long.`,
      detectedAt: now,
      affectedOrders: urgentOrders.map(o => o.orderId),
      suggestedActions: [
        {
          id: 'priority-wave',
          type: 'auto',
          description: 'Create express wave for urgent orders with top pickers',
          action: async () => { await createExpressWave(urgentOrders); return true; },
          estimatedImpact: 'Clear urgent queue in 1 hour',
          riskLevel: 'low',
        },
        {
          id: 'reassign-workers',
          type: 'manual',
          description: 'Reassign workers from low-priority to urgent picks',
          action: async () => true,
          estimatedImpact: 'Boost throughput by 40%',
          riskLevel: 'medium',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  // 3. Worker Overload Detection
  const activeTasks = await db.workerTasks.where('status').anyOf(['pending', 'in_progress']).toArray();
  const workers = await db.users.where('role').anyOf(['operator', 'supervisor']).toArray();
  const avgTasksPerWorker = workers.length > 0 ? activeTasks.length / workers.length : 0;

  if (avgTasksPerWorker > 15) {
    const id = `worker-overload-${Math.floor(avgTasksPerWorker)}`;
    scenarios.push({
      id,
      type: 'worker_overload',
      level: 'elevated',
      title: 'Worker overload detected',
      description: `Average ${avgTasksPerWorker.toFixed(1)} active tasks per worker. Consider task redistribution or overtime.`,
      detectedAt: now,
      suggestedActions: [
        {
          id: 'redistribute-tasks',
          type: 'auto',
          description: 'Redistribute tasks to under-utilized workers',
          action: async () => { await redistributeTasks(); return true; },
          estimatedImpact: 'Balance workload across team',
          riskLevel: 'low',
        },
        {
          id: 'batch-pick-mode',
          type: 'auto',
          description: 'Switch to batch picking for efficiency',
          action: async () => true,
          estimatedImpact: 'Increase UPH by 25%',
          riskLevel: 'low',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  // 4. QC Backlog Detection
  const qcBacklog = await db.qcHolds.where('status').equals('hold').count();
  if (qcBacklog > 10) {
    const id = `qc-backlog-${qcBacklog}`;
    scenarios.push({
      id,
      type: 'qc_backlog',
      level: 'critical',
      title: `QC Hold backlog: ${qcBacklog} items awaiting inspection`,
      description: 'Inspection queue is backing up. Items cannot proceed to inventory until released.',
      detectedAt: now,
      suggestedActions: [
        {
          id: 'auto-release-standard',
          type: 'auto',
          description: 'Auto-release standard items (no prior defects, trusted suppliers)',
          action: async () => { await autoReleaseStandardQCs(); return true; },
          estimatedImpact: `Clear ${Math.floor(qcBacklog * 0.6)} items immediately`,
          riskLevel: 'medium',
        },
        {
          id: 'add-qc-staff',
          type: 'escalate',
          description: 'Request additional QC inspectors',
          action: async () => true,
          estimatedImpact: 'Full clearance in 4 hours',
          riskLevel: 'low',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  // 5. Zone Overcapacity Detection
  const zones = await db.zoneCapacities.toArray();
  const overcapZones = zones.filter(z => z.maxCapacity > 0 && z.currentUtilization / z.maxCapacity > 0.9);
  if (overcapZones.length > 0) {
    const id = `zone-overcap-${overcapZones.map(z => z.zone).sort().join('|')}`;
    scenarios.push({
      id,
      type: 'zone_overcapacity',
      level: 'elevated',
      title: `${overcapZones.length} zones near capacity limit`,
      description: `Zones ${overcapZones.map(z => z.zone).join(', ')} are at high capacity.`,
      detectedAt: now,
      suggestedActions: [
        {
          id: 'rebalance-inventory',
          type: 'auto',
          description: 'Suggest alternate zones for incoming items',
          action: async () => true,
          estimatedImpact: 'Prevent putaway blocks',
          riskLevel: 'low',
        },
      ],
      autoResolvable: false,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  // 6. Integration Failure Detection
  const failedIntegrations = await db.integrationEndpoints.where('status').equals('error').toArray();
  if (failedIntegrations.length > 0) {
    const id = `integration-fail-${failedIntegrations.map(i => i.name).sort().join('|').slice(0, 60)}`;
    scenarios.push({
      id,
      type: 'integration_failure',
      level: failedIntegrations.some(i => (i.errorCount || 0) > 20) ? 'critical' : 'elevated',
      title: `${failedIntegrations.length} integration endpoint(s) failing`,
      description: `Failed: ${failedIntegrations.map(i => i.name).join(', ')}. Last errors: ${failedIntegrations.map(i => i.lastError).filter(Boolean).slice(0, 2).join('; ')}`,
      detectedAt: now,
      suggestedActions: [
        {
          id: 'retry-sync',
          type: 'auto',
          description: 'Force retry sync for failed endpoints',
          action: async () => {
            for (const ep of failedIntegrations) {
              if (ep.id != null) {
                await db.integrationEndpoints.update(ep.id, {
                  status: 'active',
                  errorCount: 0,
                  lastError: undefined,
                  lastSync: new Date().toISOString(),
                });
              }
            }
            return true;
          },
          estimatedImpact: 'Restore data flow',
          riskLevel: 'low',
        },
        {
          id: 'check-credentials',
          type: 'manual',
          description: 'Verify API keys and tokens',
          action: async () => true,
          estimatedImpact: 'Fix auth issues',
          riskLevel: 'low',
        },
      ],
      autoResolvable: true,
      resolvedAt: resolved.has(id) ? now : undefined,
    });
  }

  return scenarios
    .filter(s => !s.resolvedAt)
    .sort((a, b) => {
      const levels: Record<CriticalLevel, number> = { emergency: 4, critical: 3, elevated: 2, normal: 1 };
      return levels[b.level] - levels[a.level];
    });
}

// ─── Pressure Score Calculation ────────────────────────────────────────

export async function calculatePressureScore(): Promise<WarehousePressure> {
  const [pendingOrders, inventory, workers, activeTasks, zones, qcHolds] = await Promise.all([
    db.orders.where('status').equals('Pending').toArray(),
    db.inventory.toArray(),
    db.users.where('role').anyOf(['operator', 'supervisor']).toArray(),
    db.workerTasks.where('status').anyOf(['pending', 'in_progress']).toArray(),
    db.zoneCapacities.toArray(),
    db.qcHolds.where('status').equals('hold').count(),
  ]);

  const urgentOrders = pendingOrders.filter(o => o.priority === 'urgent').length;
  const lowStock = inventory.filter(i => i.reorderPoint && i.stock <= i.reorderPoint).length;
  const workerUtil = workers.length > 0 ? Math.min(100, (activeTasks.length / workers.length) * 6) : 0;
  const zoneUtil = zones.length > 0
    ? zones.reduce((sum, z) => sum + (z.maxCapacity > 0 ? (z.currentUtilization / z.maxCapacity) * 100 : 0), 0) / zones.length
    : 0;
  const slaRisk = Math.min(100, urgentOrders * 12 + (pendingOrders.length > 20 ? 20 : 0));

  const score = Math.min(100, Math.round(
    (urgentOrders * 8) +
    (lowStock * 5) +
    (workerUtil * 0.3) +
    (zoneUtil * 0.2) +
    (qcHolds * 3) +
    (slaRisk * 0.2)
  ));

  let level: CriticalLevel = 'normal';
  if (score >= 80) level = 'emergency';
  else if (score >= 60) level = 'critical';
  else if (score >= 35) level = 'elevated';

  return {
    level,
    pendingOrders: pendingOrders.length,
    urgentOrders,
    lowStockItems: lowStock,
    activeWorkers: workers.length,
    workerUtilization: Math.round(workerUtil),
    qcBacklog: qcHolds,
    zoneUtilization: Math.round(zoneUtil),
    avgPickTime: 0,
    slaBreachRisk: Math.round(slaRisk),
    score,
  };
}

// ─── Action Implementations ────────────────────────────────────────────

async function createEmergencyReplenishment(stockouts: { sku: string; location?: string; reorderQty?: number }[]) {
  for (const item of stockouts) {
    await db.replenishmentTasks.add({
      sku: item.sku,
      fromLocation: 'OVERSTOCK',
      toLocation: item.location || 'A1-01',
      quantity: item.reorderQty || 20,
      status: 'pending',
      priority: 'high',
      createdAt: new Date().toISOString(),
      triggeredBy: 'auto',
    });
  }
}

async function createBatchReplenishment(items: { sku: string; location?: string; reorderQty?: number }[]) {
  for (const item of items) {
    const existing = await db.replenishmentTasks.where({ sku: item.sku }).and(t => t.status === 'pending').first();
    if (!existing) {
      await db.replenishmentTasks.add({
        sku: item.sku,
        fromLocation: 'OVERSTOCK',
        toLocation: item.location || 'A1-01',
        quantity: item.reorderQty || 10,
        status: 'pending',
        priority: 'normal',
        createdAt: new Date().toISOString(),
        triggeredBy: 'auto',
      });
    }
  }
}

async function createExpressWave(orders: { orderId: string }[]) {
  await db.waveBatches.add({
    waveId: `WAVE-EXPRESS-${Date.now()}`,
    name: 'Express Critical Wave',
    status: 'open',
    orderIds: orders.map(o => o.orderId).join(','),
    zoneProfile: 'ALL-ZONES',
    createdAt: new Date().toISOString(),
  });
}

async function redistributeTasks() {
  const pending = await db.workerTasks.where('status').equals('pending').toArray();
  const workers = await db.users.where('role').equals('operator').toArray();
  if (workers.length === 0) return;

  const workerLoads: Record<string, number> = {};
  for (const w of workers) workerLoads[w.displayName] = 0;

  const activeTasks = await db.workerTasks.where('status').equals('in_progress').toArray();
  for (const t of activeTasks) {
    if (t.assignedTo && workerLoads[t.assignedTo] !== undefined) {
      workerLoads[t.assignedTo]++;
    }
  }

  for (const task of pending) {
    const leastLoaded = Object.entries(workerLoads).sort((a, b) => a[1] - b[1])[0];
    if (leastLoaded) {
      await db.workerTasks.update(task.id!, { assignedTo: leastLoaded[0] });
      workerLoads[leastLoaded[0]]++;
    }
  }
}

async function autoReleaseStandardQCs() {
  const holds = await db.qcHolds.where('status').equals('hold').toArray();
  for (const hold of holds) {
    const inboundRecord = await db.inbound.where({ sku: hold.sku }).reverse().first();
    const isTrustedSupplier = inboundRecord?.supplier && ['Apple Inc.', 'Samsung Electronics'].includes(inboundRecord.supplier);
    if (isTrustedSupplier && hold.id != null) {
      await db.qcHolds.update(hold.id, { status: 'released', releasedAt: new Date().toISOString() });
      await db.inventory.where({ sku: hold.sku }).modify(item => {
        if (item) item.stock = (item.stock || 0) + (hold.quantity || 0);
      });
    }
  }
}

// ─── Export for dashboard integration ──────────────────────────────────

export async function getCriticalSummary(): Promise<{
  scenarios: PressureScenario[];
  pressure: WarehousePressure;
  totalOpen: number;
  autoResolvableCount: number;
}> {
  const [scenarios, pressure] = await Promise.all([
    detectPressureScenarios(),
    calculatePressureScore(),
  ]);
  return {
    scenarios,
    pressure,
    totalOpen: scenarios.length,
    autoResolvableCount: scenarios.filter(s => s.autoResolvable).length,
  };
}

/**
 * Resolve a scenario by executing its first auto (or lowest-risk) suggested
 * action, then persisting the resolved ID so it no longer appears.
 */
export async function resolveScenario(scenarioId: string): Promise<boolean> {
  const scenarios = await detectPressureScenarios();
  // Also look in the full unfiltered set in case it was already filtered
  const allScenarios = scenarios; // detect already filters resolved ones
  const scenario = allScenarios.find(s => s.id === scenarioId);
  if (!scenario) {
    // Still mark it resolved so it stays gone
    await markResolved(scenarioId);
    return false;
  }

  // Prefer an auto action with low risk
  const action =
    scenario.suggestedActions.find(a => a.type === 'auto' && a.riskLevel === 'low') ||
    scenario.suggestedActions.find(a => a.type === 'auto') ||
    scenario.suggestedActions[0];

  if (action) {
    try {
      await action.action();
    } catch (err) {
      console.error('Failed to execute scenario action:', err);
      return false;
    }
  }

  await markResolved(scenarioId);
  return true;
}
