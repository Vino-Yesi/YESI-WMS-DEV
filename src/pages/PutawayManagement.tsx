import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, logAction } from '@/lib/db';
import { completePutawayTransactional } from '@/lib/lifecycle';
import { getStockScope, type StockScope } from '@/lib/stockBalances';
import { getActiveWarehouseCode } from '@/lib/supabaseSync';
import { useAuth } from '@/lib/auth';
import BarcodeReader from '@/components/BarcodeReader';
import {
  ArrowDownToLine, MapPin, PlayCircle, CheckCircle2, Clock,
  Search, Package, Truck, RefreshCw, User, Zap, ScanLine,
} from 'lucide-react';
import type { PutawayTask } from '@/lib/db';

const statusColors: Record<string, string> = {
  pending: 'text-accent-yellow',
  assigned: 'text-accent-sky',
  in_progress: 'text-accent-sky',
  completed: 'text-accent-green',
  cancelled: 'text-accent-red',
};

export default function PutawayManagement() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<PutawayTask[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<PutawayTask | null>(null);
  const [scope, setScope] = useState<StockScope>({ tenantCode: '', warehouseCode: '' });
  // Destination-bin scan: putaway is only confirmed against a bin the operator
  // actually proved they stood at.
  const [scannedBin, setScannedBin] = useState('');
  const [scanOpen, setScanOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    const active = await getStockScope(await getActiveWarehouseCode());
    setScope(active);
    const all = await db.putawayTasks
      .where('[tenantCode+warehouseCode]')
      .equals([active.tenantCode, active.warehouseCode])
      .toArray();
    const sorted = all.sort((a, b) => {
      const order = { pending: 0, assigned: 1, in_progress: 2, completed: 3, cancelled: 4 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      const prio = { urgent: 0, high: 1, normal: 2 };
      return prio[a.priority] - prio[b.priority];
    });
    setTasks(sorted);
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const filtered = tasks.filter(t => {
    if (filter !== 'all' && t.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.sku.toLowerCase().includes(q) || t.taskId.toLowerCase().includes(q) || t.product.toLowerCase().includes(q);
    }
    return true;
  });

  const stats = {
    pending: tasks.filter(t => t.status === 'pending').length,
    active: tasks.filter(t => t.status === 'in_progress' || t.status === 'assigned').length,
    completed: tasks.filter(t => t.status === 'completed').length,
  };

  const startTask = async (task: PutawayTask) => {
    setScannedBin('');
    await db.putawayTasks.update(task.id!, {
      status: 'in_progress',
      assignedTo: user?.displayName || 'operator',
      startedAt: new Date().toISOString(),
    });
    await logAction('PUTAWAY_START', `Started ${task.taskId}: ${task.sku}×${task.quantity}`, user?.displayName || 'system');
    setMessage({ type: 'success', text: `Started putaway ${task.taskId}` });
    loadTasks();
  };

  const completeTask = async (task: PutawayTask, actualLocation?: string, scannedCode?: string) => {
    if (!task.id) return;
    try {
      const res = await completePutawayTransactional({
        taskId: task.id,
        actualLocation: actualLocation || task.suggestedLocation,
        operator: user?.displayName || 'operator',
        operatorRole: user?.role || 'operator',
        // When the operator scanned the destination bin label, replay it so the
        // posting is verified against the bin rather than trusting the suggestion.
        scannedCode,
      });
      setMessage({
        type: 'success',
        text: `Putaway ${task.taskId} confirmed → ${res.location}/${res.lotNumber} (warehouse on-hand: ${res.newStock})`,
      });
      setScannedBin('');
      setSelected(null);
      loadTasks();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Putaway failed' });
    }
  };

  const createFromReceiving = async () => {
    const inbound = await db.inbound.orderBy('receivedAt').reverse().limit(3).toArray();
    const pendingInbound = inbound.filter(i => i.qcStatus === 'passed' || i.qcStatus === 'pending');
    let created = 0;

    for (const rec of pendingInbound) {
      const existing = tasks.find(t => t.sku === rec.sku && t.status === 'pending');
      if (existing) continue;

      const item = await db.inventory.where('sku').equals(rec.sku).first();
      const zone = item?.location?.split('-')[0] || 'A1';

      await db.putawayTasks.add({
        taskId: `PUT-${Date.now()}-${created}`,
        sku: rec.sku,
        product: rec.description || rec.sku,
        quantity: rec.qty,
        sourceLocation: rec.bin || 'RECV-DOCK-01',
        sourceType: 'receiving',
        suggestedLocation: item?.location || `${zone}-01`,
        destinationZone: zone,
        status: 'pending',
        priority: 'normal',
        createdAt: new Date().toISOString(),
        qcStatus: rec.qcStatus === 'passed' ? 'passed' : 'pending',
        putawayMethod: 'direct',
        operator: user?.displayName || 'system',
        estimatedTime: 15,
        distance: 60,
      });
      created++;
    }

    setMessage({ type: 'success', text: `Created ${created} putaway tasks from receiving` });
    loadTasks();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ArrowDownToLine className="w-6 h-6 text-accent-sky" />
            Putaway Management
          </h1>
          <p className="text-sm text-text-secondary mt-1">Directed putaway with zone-based slotting & QC validation</p>
        </div>
        <div className="flex gap-2">
          <button onClick={createFromReceiving} className="px-4 py-2 rounded-xl text-sm font-medium bg-accent-sky/10 text-accent-sky border border-accent-sky/20 hover:bg-accent-sky/20 transition-colors flex items-center gap-2">
            <Truck className="w-4 h-4" /> Auto-Generate
          </button>
          <button onClick={loadTasks} className="px-4 py-2 rounded-xl text-sm text-text-secondary border border-white/[0.08] hover:bg-white/[0.04] flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {message && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className={`px-4 py-3 rounded-xl text-sm border ${message.type === 'success' ? 'bg-accent-green/10 border-accent-green/20 text-accent-green' : 'bg-accent-red/10 border-accent-red/20 text-accent-red'}`}
          onClick={() => setMessage(null)}>
          {message.text}
        </motion.div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-accent-yellow' },
          { label: 'Active', value: stats.active, icon: PlayCircle, color: 'text-accent-sky' },
          { label: 'Completed', value: stats.completed, icon: CheckCircle2, color: 'text-accent-green' },
        ].map((s) => (
          <div key={s.label} className="glass-panel rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <span className="text-xs text-text-secondary uppercase tracking-wider">{s.label}</span>
            </div>
            <p className="text-2xl font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU, task ID..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-text-secondary outline-none focus:border-accent-sky/30" />
        </div>
        <div className="flex gap-1">
          {(['all', 'pending', 'in_progress', 'completed'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${filter === f ? 'bg-accent-sky/15 text-accent-sky border border-accent-sky/20' : 'text-text-secondary hover:bg-white/[0.04]'}`}>
              {f === 'in_progress' ? 'Active' : f}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-2">
        <AnimatePresence>
          {filtered.map((task) => (
            <motion.div key={task.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="glass-panel rounded-xl p-4 hover:border-accent-sky/10 transition-colors cursor-pointer"
              onClick={() => setSelected(task)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-accent-sky/10 flex items-center justify-center">
                    <Package className="w-5 h-5 text-accent-sky" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{task.taskId}</span>
                      <span className={`text-xs font-medium capitalize ${statusColors[task.status]}`}>{task.status.replace('_', ' ')}</span>
                      {task.priority !== 'normal' && <Zap className="w-3 h-3 text-accent-yellow" />}
                    </div>
                    <p className="text-xs text-text-secondary mt-0.5">{task.sku} — {task.product}</p>
                  </div>
                </div>
                <div className="flex items-center gap-6 text-right">
                  <div>
                    <p className="text-xs text-text-secondary">Qty</p>
                    <p className="text-sm font-semibold text-white">{task.quantity}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-secondary flex items-center gap-1"><MapPin className="w-3 h-3" /> Destination</p>
                    <p className="text-sm font-medium text-accent-sky">{task.suggestedLocation}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-secondary">From</p>
                    <p className="text-sm text-white/60">{task.sourceLocation}</p>
                  </div>
                  {task.status === 'pending' && (
                    <button onClick={(e) => { e.stopPropagation(); startTask(task); }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-sky/15 text-accent-sky border border-accent-sky/20 hover:bg-accent-sky/25">
                      Start
                    </button>
                  )}
                  {task.status === 'in_progress' && (
                    <button onClick={(e) => { e.stopPropagation(); completeTask(task); }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-green/15 text-accent-green border border-accent-green/20 hover:bg-accent-green/25">
                      Complete
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-text-secondary text-sm">
            No putaway tasks match your filters{scope.warehouseCode ? ` in ${scope.warehouseCode}` : ''}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <AnimatePresence>
        {selected && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setSelected(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="glass-panel rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white mb-4">{selected.taskId}</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-text-secondary">SKU</span><p className="text-white font-medium">{selected.sku}</p></div>
                <div><span className="text-text-secondary">Quantity</span><p className="text-white font-medium">{selected.quantity}</p></div>
                <div><span className="text-text-secondary">Source</span><p className="text-white">{selected.sourceLocation} ({selected.sourceType})</p></div>
                <div><span className="text-text-secondary">Destination</span><p className="text-accent-sky">{selected.suggestedLocation} (Zone {selected.destinationZone})</p></div>
                <div><span className="text-text-secondary">Method</span><p className="text-white capitalize">{selected.putawayMethod}</p></div>
                <div><span className="text-text-secondary">QC</span><p className="text-white capitalize">{selected.qcStatus}</p></div>
                <div><span className="text-text-secondary">Est. Time</span><p className="text-white">{selected.estimatedTime || '—'} min</p></div>
                <div><span className="text-text-secondary">Distance</span><p className="text-white">{selected.distance || '—'}m</p></div>
                {selected.assignedTo && <div><span className="text-text-secondary">Assigned</span><p className="text-white flex items-center gap-1"><User className="w-3 h-3" />{selected.assignedTo}</p></div>}
              </div>
              {selected.status === 'in_progress' && (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[10px] text-text-secondary uppercase tracking-widest flex items-center gap-1.5">
                      <ScanLine className="w-3.5 h-3.5 text-accent-sky" />
                      Destination bin scan
                    </span>
                    <button
                      onClick={() => setScanOpen((v) => !v)}
                      className="text-[10px] text-accent-sky hover:underline"
                    >
                      {scanOpen ? 'Hide scanner' : 'Use camera'}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={scannedBin}
                    onChange={(e) => setScannedBin(e.target.value.toUpperCase())}
                    className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                    placeholder={`Scan ${selected.suggestedLocation} to verify`}
                  />
                  {scanOpen && (
                    <div className="mt-2">
                      <BarcodeReader onScan={(code) => { setScannedBin(code.toUpperCase()); setScanOpen(false); }} />
                    </div>
                  )}
                  <p className="text-[10px] text-text-secondary/70 mt-2 leading-relaxed">
                    Confirming without a scan posts to the suggested bin{' '}
                    <span className="font-mono">{selected.suggestedLocation}</span>. A scanned bin that does not match
                    is rejected with <span className="font-mono">PUTAWAY_SCAN_MISMATCH</span>.
                  </p>
                </div>
              )}

              <div className="flex gap-2 mt-6">
                {selected.status === 'pending' && (
                  <button onClick={() => startTask(selected)} className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-accent-sky/15 text-accent-sky border border-accent-sky/20">Start Putaway</button>
                )}
                {selected.status === 'in_progress' && (
                  <button onClick={() => completeTask(selected, undefined, scannedBin)} className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-accent-green/15 text-accent-green border border-accent-green/20">Confirm Putaway</button>
                )}
                <button onClick={() => setSelected(null)} className="px-4 py-2.5 rounded-xl text-sm text-text-secondary border border-white/[0.08]">Close</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}