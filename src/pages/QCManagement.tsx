import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, logAction } from '@/lib/db';
import { createQcHoldTransactional, dispositionQcHoldTransactional } from '@/lib/lifecycle';
import { getStockScope, type StockScope } from '@/lib/stockBalances';
import { getActiveWarehouseCode } from '@/lib/supabaseSync';
import { useAuth } from '@/lib/auth';
import BarcodeReader from '@/components/BarcodeReader';
import StatusBadge from '@/components/StatusBadge';
import {
  ShieldCheck,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Plus,
  Package,
  ArrowRight,
  Ban,
  RotateCcw,
} from 'lucide-react';
import type { QCHold, InboundRecord } from '@/lib/db';

function isToday(isoString: string | undefined): boolean {
  if (!isoString) return false;
  const d = new Date(isoString);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatDuration(ms: number): string {
  if (ms < 0 || !isFinite(ms)) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export default function QCManagement() {
  const { user } = useAuth();

  // Data states
  const [qcHolds, setQcHolds] = useState<QCHold[]>([]);
  const [inboundRecords, setInboundRecords] = useState<InboundRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [holdBin, setHoldBin] = useState('QC-HOLD-AREA');
  const [scope, setScope] = useState<StockScope>({ tenantCode: '', warehouseCode: '' });
  const [scanMode, setScanMode] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // One warehouse at a time: holds and receipts from another site must never
      // appear on this floor's inspection queue.
      const active = await getStockScope(await getActiveWarehouseCode());
      setScope(active);
      const pair = [active.tenantCode, active.warehouseCode] as [string, string];
      const [holds, inbound] = await Promise.all([
        db.qcHolds.where('[tenantCode+warehouseCode]').equals(pair).toArray(),
        db.inbound.where('[tenantCode+warehouseCode]').equals(pair).reverse().limit(20).toArray(),
      ]);
      setQcHolds(holds);
      setInboundRecords(inbound);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load QC data' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleScan = (code: string) => {
    setSku(code);
    setScanMode(false);
  };

  const showMessage = (type: 'success' | 'error' | 'warning', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleCreateHold = async () => {
    if (!sku.trim()) {
      showMessage('error', 'Please enter a SKU');
      return;
    }
    if (quantity < 1) {
      showMessage('error', 'Quantity must be at least 1');
      return;
    }
    if (!reason.trim()) {
      showMessage('error', 'Please enter a reason');
      return;
    }

    try {
      // A hold physically blocks the units it names: the lifecycle step moves
      // them into a QUARANTINE dimension so FEFO can never allocate them.
      const outcome = await createQcHoldTransactional({
        sku: sku.trim(),
        lotNumber: lotNumber.trim() || undefined,
        quantity,
        reason: reason.trim(),
        bin: holdBin.trim() || undefined,
        operator: user?.displayName || 'Unknown',
        operatorRole: user?.role,
      });

      showMessage(
        outcome.unmatchedQty > 0 ? 'warning' : 'success',
        outcome.unmatchedQty > 0
          ? `Hold raised at ${outcome.bin}: ${outcome.blockedQty}× ${sku.trim()} blocked, ${outcome.unmatchedQty} not found in that bin — verify the lot/bin and correct the balance.`
          : `Hold raised at ${outcome.bin}: ${outcome.blockedQty}× ${sku.trim()} blocked from allocation`,
      );
      setSku('');
      setQuantity(1);
      setReason('');
      setLotNumber('');
      loadData();
    } catch {
      showMessage('error', 'Failed to create QC hold');
    }
  };

  const handleRelease = async (hold: QCHold) => {
    if (!hold.id) return;
    try {
      const res = await dispositionQcHoldTransactional({
        holdId: hold.id,
        disposition: 'release',
        operator: user?.displayName || 'Supervisor',
        operatorRole: user?.role,
        quarantineBin: (hold.location || holdBin).trim() || undefined,
      });
      showMessage(
        'success',
        `QC Released ${hold.quantity}× ${hold.sku} → Directed Putaway Task ${res.putawayTaskId}`
      );
      loadData();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to release QC hold');
    }
  };

  const handleReject = async (hold: QCHold) => {
    if (!hold.id) return;
    try {
      await dispositionQcHoldTransactional({
        holdId: hold.id,
        disposition: 'scrap',
        operator: user?.displayName || 'Supervisor',
        operatorRole: user?.role,
        quarantineBin: (hold.location || holdBin).trim() || undefined,
      });
      showMessage('warning', `Scrapped ${hold.quantity}× ${hold.sku} (${hold.reason})`);
      loadData();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to scrap QC hold');
    }
  };

  const handleInboundQCUpdate = async (record: InboundRecord, newStatus: 'pending' | 'passed' | 'failed') => {
    if (!record.id) return;
    try {
      await db.inbound.update(record.id, { qcStatus: newStatus });

      if (newStatus === 'failed') {
        // Auto-raise a blocking hold against the dock bin the receipt named.
        const auto = await createQcHoldTransactional({
          sku: record.sku,
          lotNumber: record.lotNumber,
          quantity: record.qty,
          reason: 'Inbound QC Failed',
          bin: record.bin?.trim() || 'RECV-DOCK-01',
          operator: user?.displayName || 'Unknown',
          operatorRole: user?.role,
        });
        if (auto.unmatchedQty > 0) {
          showMessage(
            'warning',
            `QC failed: ${auto.blockedQty}× ${record.sku} blocked at ${auto.bin}; ${auto.unmatchedQty} were not in that bin`,
          );
        }
        await logAction('QC_INBOUND_FAILED', `Inbound QC failed for ${record.qty}x ${record.sku} — auto-placed on hold`, user?.displayName || 'Unknown');
        showMessage('warning', `QC Failed — ${record.qty}x ${record.sku} placed on hold`);
      } else {
        await logAction('QC_INBOUND_UPDATE', `Inbound QC status updated to ${newStatus} for ${record.sku}`, user?.displayName || 'Unknown');
        showMessage('success', `QC status updated to ${newStatus}`);
      }

      loadData();
    } catch {
      showMessage('error', 'Failed to update QC status');
    }
  };

  // Stats
  const activeHolds = qcHolds.filter((h) => h.status === 'hold').length;
  const releasedToday = qcHolds.filter((h) => h.status === 'released' && isToday(h.releasedAt)).length;
  const rejectedToday = qcHolds.filter((h) => h.status === 'rejected' && isToday(h.releasedAt)).length;

  const resolvedHolds = qcHolds.filter((h) => (h.status === 'released' || h.status === 'rejected') && h.releasedAt && h.createdAt);
  const avgResolutionTime =
    resolvedHolds.length > 0
      ? formatDuration(
          resolvedHolds.reduce((sum, h) => {
            const created = new Date(h.createdAt).getTime();
            const released = new Date(h.releasedAt!).getTime();
            return sum + (released - created);
          }, 0) / resolvedHolds.length
        )
      : '—';

  const qcInboundRecords = inboundRecords.filter((r) => r.qcStatus === 'pending' || r.qcStatus === 'failed');

  const activeHoldList = qcHolds.filter((h) => h.status === 'hold');
  const historyList = qcHolds
    .filter((h) => h.status !== 'hold')
    .sort((a, b) => (b.releasedAt || b.createdAt).localeCompare(a.releasedAt || a.createdAt));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">QC Management</h1>
        <p className="text-sm text-text-secondary mt-1">Quality control holds, inbound reviews, and resolution tracking</p>
      </div>

      {/* Stats Dashboard */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active Holds', value: activeHolds, icon: AlertTriangle, color: 'text-accent-yellow' },
          { label: 'Released Today', value: releasedToday, icon: CheckCircle2, color: 'text-accent-green' },
          { label: 'Rejected Today', value: rejectedToday, icon: XCircle, color: 'text-accent-red' },
          { label: 'Avg Resolution Time', value: avgResolutionTime, icon: Clock, color: 'text-text-primary' },
        ].map((stat) => (
          <div key={stat.label} className="glass-panel rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-secondary uppercase tracking-widest">{stat.label}</span>
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
            </div>
            <span className="text-2xl font-bold text-text-primary">{stat.value}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Create QC Hold */}
        <div className="glass-panel rounded-lg p-6">
          <div className="flex items-center gap-2 mb-6">
            <Ban className="w-5 h-5 text-accent-sky" />
            <h2 className="text-sm font-semibold text-text-primary">Create QC Hold</h2>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest">SKU</label>
                <button
                  onClick={() => setScanMode(!scanMode)}
                  className="text-[10px] bg-accent-sky/20 text-accent-sky px-2 py-0.5 rounded-full hover:bg-accent-sky/30 transition-colors"
                >
                  {scanMode ? 'Manual Entry' : 'Scan'}
                </button>
              </div>

              {scanMode ? (
                <BarcodeReader onScan={handleScan} placeholder="Scan SKU barcode..." />
              ) : (
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                  placeholder="Enter SKU"
                />
              )}
            </div>

            <div>
              <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">Quantity</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
                className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors"
              />
            </div>

            <div>
              <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors"
                placeholder="e.g., Damaged packaging, Failed inspection..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">Lot Number (Optional)</label>
                <input
                  type="text"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                  placeholder="LOT-XXXX"
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">Quarantine bin</label>
                <input
                  type="text"
                  value={holdBin}
                  onChange={(e) => setHoldBin(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-yellow transition-colors font-mono"
                  placeholder="QC-HOLD-AREA"
                />
              </div>
            </div>
            <p className="text-[10px] text-text-secondary/70 leading-relaxed">
              Units found in that bin are moved to <span className="font-mono text-accent-yellow">QUARANTINE</span> and
              removed from FEFO allocation immediately. Units not present there are reported, never assumed.
            </p>

            <AnimatePresence>
              {message && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={`p-3 rounded-md text-xs ${
                    message.type === 'success'
                      ? 'bg-accent-green/10 border border-accent-green/20 text-accent-green'
                      : message.type === 'warning'
                        ? 'bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow'
                        : 'bg-accent-red/10 border border-accent-red/20 text-accent-red'
                  }`}
                >
                  {message.text}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              onClick={handleCreateHold}
              whileTap={{ scale: 0.98 }}
              className="w-full flex items-center justify-center gap-2 py-3 bg-accent-sky text-void font-semibold text-sm rounded-md hover:bg-accent-sky/90 transition-colors active:translate-y-[1px]"
            >
              <Plus className="w-4 h-4" />
              Create Hold
            </motion.button>
          </div>
        </div>

        {/* Active QC Holds */}
        <div className="lg:col-span-2 glass-panel rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="w-5 h-5 text-accent-yellow" />
            <h2 className="text-sm font-semibold text-text-primary">Active QC Holds</h2>
            {scope.warehouseCode && (
              <span className="text-[10px] font-mono bg-white/[0.06] text-text-secondary px-2 py-0.5 rounded-full">
                {scope.warehouseCode} · {scope.tenantCode}
              </span>
            )}
            <span className="ml-auto text-[10px] text-text-secondary uppercase tracking-widest">
              {activeHoldList.length} item{activeHoldList.length !== 1 ? 's' : ''}
            </span>
          </div>

          {loading ? (
            <p className="text-xs text-text-secondary text-center py-8">Loading...</p>
          ) : activeHoldList.length === 0 ? (
            <div className="text-center py-10">
              <ShieldCheck className="w-8 h-8 text-accent-green mx-auto mb-2 opacity-50" />
              <p className="text-xs text-text-secondary">No active QC holds</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
              {activeHoldList.map((hold) => (
                <motion.div
                  key={hold.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-md"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-text-secondary" />
                      <span className="text-xs font-mono font-medium text-text-primary">{hold.sku}</span>
                      {hold.lotNumber && (
                        <span className="text-[10px] text-accent-yellow font-mono">Lot: {hold.lotNumber}</span>
                      )}
                    </div>
                    <StatusBadge status="Pending" />
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <div>
                      <span className="text-[10px] text-text-secondary uppercase tracking-widest">Qty</span>
                      <p className="text-xs text-text-primary font-semibold">{hold.quantity}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-[10px] text-text-secondary uppercase tracking-widest">Reason</span>
                      <p className="text-xs text-text-primary truncate">{hold.reason}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-text-secondary">
                      By {hold.operator} · {new Date(hold.createdAt).toLocaleDateString()}
                    </div>
                    <div className="flex items-center gap-2">
                      <motion.button
                        onClick={() => handleRelease(hold)}
                        whileTap={{ scale: 0.95 }}
                        className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold bg-accent-green/20 text-accent-green border border-accent-green/30 rounded-md hover:bg-accent-green/30 transition-colors"
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        Release
                      </motion.button>
                      <motion.button
                        onClick={() => handleReject(hold)}
                        whileTap={{ scale: 0.95 }}
                        className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold bg-accent-red/20 text-accent-red border border-accent-red/30 rounded-md hover:bg-accent-red/30 transition-colors"
                      >
                        <XCircle className="w-3 h-3" />
                        Reject
                      </motion.button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Inbound QC Review */}
      <div className="mt-6 glass-panel rounded-lg p-6">
        <div className="flex items-center gap-2 mb-4">
          <RotateCcw className="w-5 h-5 text-accent-sky" />
          <h2 className="text-sm font-semibold text-text-primary">Inbound QC Review</h2>
          <span className="ml-auto text-[10px] text-text-secondary uppercase tracking-widest">
            {qcInboundRecords.length} pending/failed
          </span>
        </div>

        {loading ? (
          <p className="text-xs text-text-secondary text-center py-8">Loading...</p>
        ) : qcInboundRecords.length === 0 ? (
          <div className="text-center py-6">
            <ShieldCheck className="w-8 h-8 text-accent-green mx-auto mb-2 opacity-50" />
            <p className="text-xs text-text-secondary">No pending or failed inbound QC records</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {qcInboundRecords.map((record) => (
              <motion.div
                key={record.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-md"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-medium text-text-primary">{record.sku}</span>
                  <span
                    className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${
                      record.qcStatus === 'pending'
                        ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/30'
                        : 'bg-accent-red/20 text-accent-red border-accent-red/30'
                    }`}
                  >
                    {record.qcStatus}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <span className="text-[10px] text-text-secondary uppercase tracking-widest">Qty</span>
                    <p className="text-xs text-text-primary font-semibold">{record.qty}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-text-secondary uppercase tracking-widest">Bin</span>
                    <p className="text-xs text-text-primary font-mono">{record.bin}</p>
                  </div>
                  {record.lotNumber && (
                    <div className="col-span-2">
                      <span className="text-[10px] text-text-secondary uppercase tracking-widest">Lot</span>
                      <p className="text-xs text-accent-yellow font-mono">{record.lotNumber}</p>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {(['pending', 'passed', 'failed'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => handleInboundQCUpdate(record, s)}
                      className={`flex-1 py-1.5 text-[10px] rounded-md border transition-all uppercase font-semibold ${
                        record.qcStatus === s
                          ? s === 'passed'
                            ? 'bg-accent-green/20 border-accent-green/40 text-accent-green'
                            : s === 'failed'
                              ? 'bg-accent-red/20 border-accent-red/40 text-accent-red'
                              : 'bg-accent-yellow/20 border-accent-yellow/40 text-accent-yellow'
                          : 'bg-white/[0.02] border-white/[0.06] text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* QC Hold History */}
      {historyList.length > 0 && (
        <div className="mt-6 glass-panel rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <ArrowRight className="w-5 h-5 text-text-secondary" />
            <h2 className="text-sm font-semibold text-text-primary">Resolution History</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {historyList.slice(0, 12).map((hold) => (
              <div key={hold.id} className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-md">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-medium text-text-primary">{hold.sku}</span>
                  <StatusBadge status={hold.status === 'released' ? 'In Stock' : 'Returned'} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-text-secondary">
                  <span>Qty: {hold.quantity}</span>
                  <span>{hold.releasedAt ? new Date(hold.releasedAt).toLocaleDateString() : '—'}</span>
                </div>
                <p className="text-[10px] text-text-secondary mt-1 truncate">{hold.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
