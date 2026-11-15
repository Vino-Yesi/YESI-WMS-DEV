import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, type StockBalance } from '@/lib/db';
import { confirmPickAndPackTransactional } from '@/lib/lifecycle';
import { getStockScope } from '@/lib/stockBalances';
import { getActiveWarehouseCode } from '@/lib/supabaseSync';
import { useAuth } from '@/lib/auth';
import BarcodeReader from '@/components/BarcodeReader';
import StatusBadge from '@/components/StatusBadge';
import { PackageOpen, CheckCircle, ScanBarcode, X, Zap } from 'lucide-react';
import type { Order, InventoryItem } from '@/lib/db';

interface RequiredItem {
  sku: string;
  quantity: number;
  picked: number;
  /** Raw scans captured for this line, in scan order (one per unit). */
  scans: string[];
}

/** FEFO bin guidance for one SKU line inside the active warehouse. */
interface BinHint {
  location: string;
  lotNumber: string;
  expiryDate: string | null;
  available: number;
}

export default function PickPack() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [requiredItems, setRequiredItems] = useState<RequiredItem[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [ripple, setRipple] = useState(false);
  const [pickMode, setPickMode] = useState<'standard' | 'wave'>('standard');
  const [waveOrders, setWaveOrders] = useState<Order[]>([]);
  const [wavePicks, setWavePicks] = useState<Record<string, number>>({});
  const [waveScans, setWaveScans] = useState<Record<string, string[]>>({});
  const [warehouse, setWarehouse] = useState<string>('');
  const [tenantCode, setTenantCode] = useState<string>('');
  const [balances, setBalances] = useState<StockBalance[]>([]);

  const loadData = useCallback(async () => {
    // Strict warehouse scoping: a picker in SHJ-HUB2 must never see or confirm
    // DXB-FC1 stock.
    const scope = await getStockScope(await getActiveWarehouseCode());
    const [ords, inv, bals] = await Promise.all([
      db.orders.where('[tenantCode+warehouseCode]').equals([scope.tenantCode, scope.warehouseCode]).toArray(),
      db.inventory.where('[tenantCode+warehouseCode]').equals([scope.tenantCode, scope.warehouseCode]).toArray(),
      db.stockBalances.where('[tenantCode+warehouseCode]').equals([scope.tenantCode, scope.warehouseCode]).toArray(),
    ]);
    setTenantCode(scope.tenantCode);
    setWarehouse(scope.warehouseCode);
    setOrders(ords);
    setInventory(inv);
    setBalances(bals);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const pendingOrders = orders.filter(o => o.status === 'Pending' || o.status === 'Picking');

  const getRequiredItems = (order: Order): RequiredItem[] => {
    const skus = order.requiredSkus.split(',').map(s => s.trim()).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const sku of skus) {
      counts[sku] = (counts[sku] || 0) + 1;
    }
    return Object.entries(counts).map(([sku, quantity]) => ({ sku, quantity, picked: 0, scans: [] }));
  };

  /**
   * FEFO bin hints for a SKU: every bin that holds allocatable units of it,
   * soonest usable expiry first. A SKU split across three bins shows three rows,
   * so the picker walks the correct aisle instead of guessing.
   */
  const getBinHints = useCallback(
    (sku: string): BinHint[] => {
      const rows = balances
        .filter((b) => b.sku === sku && b.stockStatus === 'AVAILABLE')
        .map((b) => ({
          location: b.location,
          lotNumber: b.lotNumber,
          expiryDate: b.expiryDate ?? null,
          available: Math.max(0, b.onHandQty - b.reservedQty - b.quarantineQty),
        }))
        .filter((b) => b.available > 0)
        .sort((a, b) =>
          (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31') ||
          a.location.localeCompare(b.location),
        );
      return rows;
    },
    [balances],
  );

  /** Resolves a scanned barcode / serial / lot into the SKU it belongs to. */
  const resolveScan = useCallback(
    async (code: string): Promise<{ sku: string; location?: string; lotNumber?: string; kind: 'sku' | 'barcode' | 'serial' | 'lot' } | null> => {
      const clean = code.trim();
      if (!clean) return null;

      const serial = await db.serialNumbers.where('serialNumber').equals(clean).first();
      if (serial) return { sku: serial.sku, location: serial.location, kind: 'serial' };

      const byBarcode = inventory.find((i) => i.barcode === clean || i.rfidTag === clean);
      if (byBarcode) return { sku: byBarcode.sku, location: byBarcode.location, lotNumber: byBarcode.lotNumber, kind: 'barcode' };

      const bySku = inventory.find((i) => i.sku === clean);
      if (bySku) return { sku: bySku.sku, location: bySku.location, lotNumber: bySku.lotNumber, kind: 'sku' };

      const dim = balances.find((b) => b.lotNumber.toUpperCase() === clean.toUpperCase());
      if (dim) return { sku: dim.sku, location: dim.location, lotNumber: dim.lotNumber, kind: 'lot' };

      return null;
    },
    [inventory, balances],
  );

  const getProductName = (sku: string) => {
    const item = inventory.find(i => i.sku === sku);
    return item?.product || 'Unknown SKU';
  };

  const getItemLocation = (sku: string) => {
    const hints = getBinHints(sku);
    if (hints.length > 0) return hints[0].location;
    const item = inventory.find(i => i.sku === sku);
    return item?.location || 'UNASSIGNED';
  };

  const handleScan = async (code: string) => {
    if (pickMode === 'wave' && waveOrders.length > 0) {
      await handleWaveScan(code);
      return;
    }
    if (!selectedOrder) return;

    // A scanner yields a barcode, IMEI/serial or lot label — not necessarily the
    // SKU code. Resolve it first so the raw scan can be replayed to the server
    // for verification.
    const resolved = await resolveScan(code);
    if (!resolved) {
      setMessage({ type: 'error', text: `Scan "${code}" is not registered in ${warehouse}` });
      return;
    }

    const items = getRequiredItems(selectedOrder);
    const requiredSku = items.find(item => item.sku === resolved.sku);

    if (!requiredSku) {
      setMessage({ type: 'error', text: `${resolved.sku} (scan ${code}) is not required for this order` });
      return;
    }

    const currentItem = requiredItems.find(r => r.sku === resolved.sku);
    const currentPicked = currentItem?.picked || 0;

    if (currentPicked >= requiredSku.quantity) {
      setMessage({ type: 'warning', text: `All ${requiredSku.quantity} units of ${resolved.sku} already picked` });
      return;
    }

    // Duplicate scan guard: the same physical unit cannot be picked twice.
    if (currentItem?.scans.includes(code)) {
      setMessage({ type: 'warning', text: `Scan ${code} was already counted for ${resolved.sku}` });
      return;
    }

    // Bin-level availability, not a per-SKU total.
    const hints = getBinHints(resolved.sku);
    const freeUnits = hints.reduce((sum, h) => sum + h.available, 0);
    if (freeUnits <= 0) {
      setMessage({ type: 'error', text: `${resolved.sku} has no allocatable units in ${warehouse}` });
      return;
    }
    const nextBin = hints.find(h => h.available > currentPicked) ?? hints[0];

    setRequiredItems(prev => {
      const existing = prev.find(p => p.sku === resolved.sku);
      if (existing) {
        return prev.map(p =>
          p.sku === resolved.sku ? { ...p, picked: p.picked + 1, scans: [...p.scans, code] } : p,
        );
      }
      return [...prev, { sku: resolved.sku, quantity: requiredSku.quantity, picked: 1, scans: [code] }];
    });

    triggerRipple();
    setMessage({
      type: 'success',
      text: `Picked 1× ${resolved.sku} from ${nextBin.location}/${nextBin.lotNumber}${nextBin.expiryDate ? ` (exp ${nextBin.expiryDate})` : ''} — scan ${resolved.kind}`,
    });
  };

  const handleWaveScan = async (code: string) => {
    const resolved = await resolveScan(code);
    if (!resolved) {
      setMessage({ type: 'error', text: `Scan "${code}" is not registered in ${warehouse}` });
      return;
    }
    const sku = resolved.sku;
    const allRequired = waveOrders.flatMap(o => getRequiredItems(o));
    const needed = allRequired.find(r => r.sku === sku && (wavePicks[sku] || 0) < r.quantity);

    if (!needed) {
      setMessage({ type: 'error', text: `${sku} (scan ${code}) is not needed in the current wave` });
      return;
    }

    const hints = getBinHints(sku);
    const freeUnits = hints.reduce((sum, h) => sum + h.available, 0);
    if (freeUnits - (wavePicks[sku] || 0) <= 0) {
      setMessage({ type: 'error', text: `${sku} has no remaining allocatable units in ${warehouse}` });
      return;
    }

    setWavePicks(prev => ({ ...prev, [sku]: (prev[sku] || 0) + 1 }));
    setWaveScans(prev => ({ ...prev, [sku]: [...(prev[sku] || []), code] }));
    triggerRipple();
    setMessage({ type: 'success', text: `Wave pick: ${sku} from ${hints[0]?.location ?? 'FEFO bin'} (scan ${resolved.kind})` });
  };

  const triggerRipple = () => {
    setRipple(true);
    setTimeout(() => setRipple(false), 600);
  };

  const handleVerifyAndShip = async () => {
    if (!selectedOrder || !selectedOrder.id) return;
    const items = getRequiredItems(selectedOrder);
    const allPicked = items.every(req => {
      const picked = requiredItems.find(r => r.sku === req.sku)?.picked || 0;
      return picked >= req.quantity;
    });

    if (!allPicked) {
      const missing = items
        .filter(req => (requiredItems.find(r => r.sku === req.sku)?.picked || 0) < req.quantity)
        .map(req => `${req.sku} (${requiredItems.find(r => r.sku === req.sku)?.picked || 0}/${req.quantity})`);
      setMessage({ type: 'error', text: `Incomplete pick: ${missing.join(', ')}` });
      return;
    }

    try {
      await confirmPickAndPackTransactional({
        orderRecordId: selectedOrder.id,
        pickedItems: requiredItems.map((r) => {
          const hints = getBinHints(r.sku);
          const bin = hints[0];
          return {
            sku: r.sku,
            picked: r.picked,
            // The last scan captured for the line is replayed to the server so
            // the cloud RPC performs the same verification.
            scannedCode: r.scans[r.scans.length - 1],
            location: bin?.location,
            lotNumber: bin?.lotNumber,
          };
        }),
        operator: user?.displayName || 'Operator',
        operatorRole: user?.role || 'operator',
        tenantCode,
        warehouseCode: warehouse,
      });
      setMessage({
        type: 'success',
        text: `Order ${selectedOrder.orderId} pick-verified & Packed! Ready for Carrier Label & Manifest in Shipping.`,
      });
      setSelectedOrder(null);
      setRequiredItems([]);
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Pack verification failed' });
    }
  };

  const handleCreateWave = async () => {
    if (pendingOrders.length === 0) return;
    // Select up to 3 orders by zone proximity for demo
    const wave = pendingOrders.slice(0, 3);
    setWaveOrders(wave);
    setWavePicks({});
    setWaveScans({});
    setPickMode('wave');
    setMessage({ type: 'success', text: `Wave created with ${wave.length} orders` });
    
    const waveId = `WAVE-${Date.now()}`;
    await db.waveBatches.add({
      waveId,
      name: `Auto Wave ${new Date().toLocaleDateString()}`,
      status: 'open',
      orderIds: wave.map(o => o.orderId).join(','),
      zoneProfile: 'mixed',
      createdAt: new Date().toISOString(),
    });
  };

  const handleWaveComplete = async () => {
    try {
      let packedCount = 0;
      for (const order of waveOrders) {
        if (!order.id) continue;
        const items = getRequiredItems(order);
        const allPicked = items.every(req => (wavePicks[req.sku] || 0) >= req.quantity);
        if (allPicked) {
          await confirmPickAndPackTransactional({
            orderRecordId: order.id,
            pickedItems: items.map((i) => {
              const hints = getBinHints(i.sku);
              const bin = hints[0];
              const scans = waveScans[i.sku] || [];
              return {
                sku: i.sku,
                picked: i.quantity,
                scannedCode: scans[scans.length - 1],
                location: bin?.location,
                lotNumber: bin?.lotNumber,
              };
            }),
            operator: user?.displayName || 'Operator',
            operatorRole: user?.role || 'operator',
            tenantCode,
            warehouseCode: warehouse,
          });
          packedCount++;
        }
      }
      setWaveOrders([]);
      setWavePicks({});
      setWaveScans({});
      setPickMode('standard');
      loadData();
      setMessage({
        type: 'success',
        text: `Wave pick completed: ${packedCount} order(s) Packed and staged for Carrier Shipping!`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Wave pack failed' });
    }
  };

  const sortedRequiredItems = (items: RequiredItem[]) => {
    return [...items].sort((a, b) => {
      const locA = getItemLocation(a.sku);
      const locB = getItemLocation(b.sku);
      return locA.localeCompare(locB);
    });
  };

  return (
    <div>
      {/* Ripple Effect */}
      <AnimatePresence>
        {ripple && (
          <motion.div
            initial={{ scale: 0, opacity: 0.6 }}
            animate={{ scale: 4, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="fixed top-1/2 left-1/2 w-[100px] h-[100px] -ml-[50px] -mt-[50px] rounded-full pointer-events-none z-[9999]"
            style={{
              background: 'radial-gradient(circle, rgba(255, 107, 53, 0.4) 0%, transparent 70%)',
            }}
          />
        )}
      </AnimatePresence>

      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Pick & Pack</h1>
            <p className="text-sm text-text-secondary mt-1">Fulfillment: scan, verify, and ship orders</p>
          </div>
          <div className="flex gap-2">
            {pickMode === 'standard' ? (
              <motion.button
                onClick={handleCreateWave}
                whileTap={{ scale: 0.98 }}
                className="flex items-center gap-2 px-4 py-2 bg-accent-sky/20 text-accent-sky text-xs font-semibold rounded-md hover:bg-accent-sky/30 transition-colors"
              >
                <Zap className="w-3.5 h-3.5" />
                Create Wave
              </motion.button>
            ) : (
              <motion.button
                onClick={handleWaveComplete}
                whileTap={{ scale: 0.98 }}
                className="flex items-center gap-2 px-4 py-2 bg-accent-green/20 text-accent-green text-xs font-semibold rounded-md hover:bg-accent-green/30 transition-colors"
              >
                <CheckCircle className="w-3.5 h-3.5" />
                Complete Wave
              </motion.button>
            )}
          </div>
        </div>
      </div>

      {pickMode === 'wave' && waveOrders.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-accent-sky/10 border border-accent-sky/20 rounded-md"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-accent-sky font-semibold">
              Wave Pick Mode — {waveOrders.length} orders
            </span>
            <button onClick={() => { setPickMode('standard'); setWaveOrders([]); setWavePicks({}); }} className="text-[10px] text-text-secondary hover:text-text-primary">
              Cancel
            </button>
          </div>
          <div className="flex gap-2 mt-2 flex-wrap">
            {waveOrders.map(o => (
              <span key={o.id} className="text-[10px] bg-white/[0.05] text-text-secondary px-2 py-0.5 rounded font-mono">{o.orderId}</span>
            ))}
          </div>
        </motion.div>
      )}

      {!selectedOrder && pickMode === 'standard' ? (
        <div className="glass-panel rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <PackageOpen className="w-5 h-5 text-accent-sky" />
            <h2 className="text-sm font-semibold text-text-primary">Pending Orders</h2>
            <span className="ml-auto text-[10px] bg-accent-yellow/20 text-accent-yellow px-2 py-0.5 rounded-full">
              {pendingOrders.length} pending
            </span>
          </div>

          {pendingOrders.length === 0 ? (
            <div className="text-center py-12">
              <CheckCircle className="w-10 h-10 text-accent-green mx-auto mb-3" />
              <p className="text-sm font-semibold text-text-primary">All caught up!</p>
              <p className="text-xs text-text-secondary mt-1">No pending orders to fulfill</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pendingOrders.map((order) => {
                const items = getRequiredItems(order);
                const zones = [...new Set(items.map(i => getItemLocation(i.sku).split('-')[0]))].sort();
                return (
                  <motion.button
                    key={order.id}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => { setSelectedOrder(order); setRequiredItems([]); setMessage(null); }}
                    className="text-left p-4 bg-white/[0.02] border border-white/[0.06] rounded-md hover:border-accent-sky/30 transition-all"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-mono font-semibold text-text-primary">{order.orderId}</span>
                      <div className="flex items-center gap-2">
                        {order.priority !== 'normal' && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ${
                            order.priority === 'urgent' ? 'bg-accent-red/20 text-accent-red' : 'bg-accent-yellow/20 text-accent-yellow'
                          }`}>
                            {order.priority.toUpperCase()}
                          </span>
                        )}
                        <StatusBadge status={order.status} />
                      </div>
                    </div>
                    <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-1">Required SKUs:</p>
                    <div className="space-y-1">
                      {items.map(req => (
                        <div key={req.sku} className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-text-secondary">{req.sku}</span>
                          <span className="text-[10px] text-text-secondary truncate">{getProductName(req.sku)}</span>
                          <span className="text-[10px] text-accent-sky ml-auto">x{req.quantity}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 mt-2">
                      <span className="text-[9px] text-text-secondary">Zones: {zones.join(', ')}</span>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Order Details */}
          <div className="glass-panel rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <ScanBarcode className="w-5 h-5 text-accent-sky" />
              <h2 className="text-sm font-semibold text-text-primary">
                {pickMode === 'wave' ? 'Wave Picking' : `Order: ${selectedOrder?.orderId}`}
              </h2>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-sky/10 text-accent-sky font-mono">
                {warehouse}
              </span>
              <button
                onClick={() => { setSelectedOrder(null); setRequiredItems([]); setMessage(null); setPickMode('standard'); }}
                className="ml-auto text-[10px] text-text-secondary hover:text-text-primary flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Back to List
              </button>
            </div>

            {pickMode === 'wave' ? (
              <div>
                <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-3">Wave Items (Optimized by Zone):</p>
                {(() => {
                  const allItems = waveOrders.flatMap(o => getRequiredItems(o));
                  const consolidated: Record<string, RequiredItem> = {};
                  for (const item of allItems) {
                    if (!consolidated[item.sku]) consolidated[item.sku] = { ...item, picked: 0 };
                    consolidated[item.sku].quantity += item.quantity - 1; // already 1 from first
                  }
                  const sorted = Object.values(consolidated).sort((a, b) => getItemLocation(a.sku).localeCompare(getItemLocation(b.sku)));
                  return (
                    <div className="space-y-2 mb-6">
                      {sorted.map((req) => {
                        const picked = wavePicks[req.sku] || 0;
                        const isComplete = picked >= req.quantity;
                        return (
                          <div key={req.sku} className={`flex items-center gap-3 p-3 rounded-md border transition-all ${
                            isComplete ? 'bg-accent-green/5 border-accent-green/20' : 'bg-white/[0.02] border-white/[0.06]'
                          }`}>
                            <div className="flex-shrink-0">
                              {isComplete ? (
                                <CheckCircle className="w-4 h-4 text-accent-green" />
                              ) : (
                                <div className="w-4 h-4 rounded-full border-2 border-white/20" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-xs font-mono ${isComplete ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{req.sku}</p>
                              <p className={`text-[10px] ${isComplete ? 'text-text-secondary/60 line-through' : 'text-text-secondary'}`}>{getProductName(req.sku)}</p>
                              <p className="text-[10px] text-accent-sky font-mono">{getItemLocation(req.sku)}</p>
                            </div>
                            <span className="text-xs font-semibold text-text-primary">{picked}/{req.quantity}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <>
                <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-3">Required Items (Optimized by Zone):</p>
                <div className="space-y-2 mb-6">
                  {sortedRequiredItems(getRequiredItems(selectedOrder!)).map((req) => {
                    const current = requiredItems.find(r => r.sku === req.sku);
                    const picked = current?.picked || 0;
                    const isComplete = picked >= req.quantity;
                    return (
                      <motion.div
                        key={req.sku}
                        className={`flex items-center gap-3 p-3 rounded-md border transition-all ${
                          isComplete
                            ? 'bg-accent-green/5 border-accent-green/20'
                            : 'bg-white/[0.02] border-white/[0.06]'
                        }`}
                        animate={isComplete ? { backgroundColor: 'rgba(46, 204, 113, 0.05)' } : {}}
                      >
                        <div className="flex-shrink-0">
                          {isComplete ? (
                            <CheckCircle className="w-4 h-4 text-accent-green" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border-2 border-white/20 flex-shrink-0" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-mono ${isComplete ? 'line-through text-text-secondary' : 'text-text-primary'}`}>
                            {req.sku}
                          </p>
                          <p className={`text-[10px] ${isComplete ? 'line-through text-text-secondary/60' : 'text-text-secondary'}`}>
                            {getProductName(req.sku)}
                          </p>
                          {/* FEFO bin walk-list: one row per bin that actually
                              holds allocatable units, soonest expiry first. */}
                          <div className="mt-1 space-y-0.5">
                            {(() => {
                              const hints = getBinHints(req.sku);
                              if (hints.length === 0) {
                                return (
                                  <p className="text-[10px] text-accent-red font-mono">
                                    NO ALLOCATABLE STOCK IN {warehouse}
                                  </p>
                                );
                              }
                              let stillNeeded = req.quantity;
                              return hints.slice(0, 4).map((h) => {
                                const takeFromBin = Math.max(0, Math.min(h.available, stillNeeded));
                                stillNeeded -= takeFromBin;
                                return (
                                  <p
                                    key={`${h.location}|${h.lotNumber}`}
                                    className={`text-[10px] font-mono flex items-center gap-1.5 ${
                                      takeFromBin > 0 ? 'text-accent-sky' : 'text-text-secondary/70'
                                    }`}
                                  >
                                    <span className="font-semibold">{h.location}</span>
                                    <span className="text-text-secondary">LOT {h.lotNumber}</span>
                                    {h.expiryDate && (
                                      <span className="text-accent-yellow">EXP {h.expiryDate}</span>
                                    )}
                                    <span className="ml-auto">
                                      {takeFromBin > 0 ? `pick ${takeFromBin}` : `${h.available} free`}
                                    </span>
                                  </p>
                                );
                              });
                            })()}
                            {getBinHints(req.sku).length > 4 && (
                              <p className="text-[9px] text-text-secondary">
                                +{getBinHints(req.sku).length - 4} more bin(s)
                              </p>
                            )}
                          </div>
                          {current && current.scans.length > 0 && (
                            <p className="text-[9px] text-text-secondary/70 font-mono mt-1">
                              scans: {current.scans.slice(-3).join(', ')}
                            </p>
                          )}
                        </div>
                        <span className="text-xs font-semibold text-text-primary">{picked}/{req.quantity}</span>
                      </motion.div>
                    );
                  })}
                </div>

                <AnimatePresence>
                  {message && (
                    <motion.div
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className={`mb-4 p-3 rounded-md text-xs ${
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
                  onClick={handleVerifyAndShip}
                  whileTap={{ scale: 0.98 }}
                  disabled={requiredItems.length === 0}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-accent-sky text-void font-semibold text-sm rounded-md hover:bg-accent-sky/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed active:translate-y-[1px]"
                >
                  <CheckCircle className="w-4 h-4" />
                  Verify Pick &amp; Pack Carton
                </motion.button>
              </>
            )}
          </div>

          {/* Scan Zone */}
          <div className="glass-panel rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <ScanBarcode className="w-5 h-5 text-accent-sky" />
              <h2 className="text-sm font-semibold text-text-primary">Scan Zone</h2>
              <span className="ml-auto text-[10px] text-text-secondary">
                {pickMode === 'wave' 
                  ? `${Object.values(wavePicks).reduce((a, b) => a + b, 0)} picks`
                  : `${requiredItems.reduce((sum, r) => sum + r.picked, 0)} / ${getRequiredItems(selectedOrder!).reduce((sum, r) => sum + r.quantity, 0)} picked`
                }
              </span>
            </div>

            <BarcodeReader
              onScan={handleScan}
              placeholder="Scan barcode or type SKU and press Enter..."
            />

            {(pickMode === 'standard' ? requiredItems.length > 0 : Object.keys(wavePicks).length > 0) && (
              <div className="mt-4">
                <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">Picked Items</p>
                <div className="flex flex-wrap gap-1.5">
                  {(pickMode === 'standard' ? requiredItems : Object.entries(wavePicks).map(([sku, qty]) => ({ sku, picked: qty, quantity: qty }))).map((item, i) => (
                    <span
                      key={`${item.sku}-${i}`}
                      className="text-[10px] bg-accent-green/20 text-accent-green px-2 py-1 rounded font-mono"
                    >
                      {item.sku} x{item.picked}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
