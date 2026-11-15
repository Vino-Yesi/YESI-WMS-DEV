import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, logAction, type StockBalance } from '@/lib/db';
import { getStockScope, upsertDimension, refreshInventoryRollup, type StockScope } from '@/lib/stockBalances';
import { getActiveWarehouseCode, enqueueCloudOperation } from '@/lib/supabaseSync';
import { useAuth } from '@/lib/auth';
import { AlertTriangle, Search, Package, MapPin, Barcode, Hash, DollarSign, Timer, Calendar, TrendingUp, Plus, X, History, Tag, Box, Ruler, ScanLine, Truck, ShieldAlert, Sparkles } from 'lucide-react';
import BarcodeReader from '@/components/BarcodeReader';
import type { InventoryItem, InventoryMovement, InboundRecord } from '@/lib/db';
import { sentinel, oracle, type AnomalyAlert, type ForecastResult } from '@/lib/neuralOps';

const ZONES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'C3', 'D1', 'D2', 'E1'];

const VELOCITY_COLORS: Record<string, string> = {
  high: 'text-accent-sky',
  medium: 'text-accent-yellow',
  low: 'text-text-secondary',
};

function getABCClass(item: InventoryItem): 'A' | 'B' | 'C' {
  const value = (item.costPerUnit || 0) * (item.stock || 0);
  if (value >= 5000) return 'A';
  if (value >= 1000) return 'B';
  return 'C';
}

function getABCColor(cls: 'A' | 'B' | 'C'): string {
  return cls === 'A' ? 'text-accent-sky' : cls === 'B' ? 'text-accent-yellow' : 'text-text-secondary';
}

function daysUntilExpiry(expiryDate?: string): number | null {
  if (!expiryDate) return null;
  const diff = new Date(expiryDate).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export default function InventoryHub() {
  const { user, can } = useAuth();
  const canAdjustStock = can('inventory.adjust');
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([]);
  const [oraclePreview, setOraclePreview] = useState<{ sku: string; result: ForecastResult } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editStock, setEditStock] = useState('');
  const [hoveredLocation, setHoveredLocation] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterVelocity, setFilterVelocity] = useState<string | null>(null);
  const [filterABC, setFilterABC] = useState<'A' | 'B' | 'C' | null>(null);
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'traceability' | 'expiry'>('all');
  const [showScanner, setShowScanner] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [lotInboundRecords, setLotInboundRecords] = useState<InboundRecord[]>([]);
  // v3: dimensional stock + active scope. Every query on this screen is bound to
  // ONE warehouse, and every adjustment names the bin/lot it touches.
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [scope, setScope] = useState<StockScope>({ tenantCode: '', warehouseCode: '' });
  const [adjustBin, setAdjustBin] = useState<string>('');
  const [adjustLot, setAdjustLot] = useState<string>('');
  const [adjustStatus, setAdjustStatus] = useState<'AVAILABLE' | 'QUARANTINE' | 'DAMAGED'>('AVAILABLE');
  const [overrideError, setOverrideError] = useState<string>('');
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const ROW_HEIGHT = 44;
  const VIEWPORT_HEIGHT = 480;

  const loadInventory = useCallback(async () => {
    const active = await getStockScope(await getActiveWarehouseCode());
    setScope(active);
    const pair = [active.tenantCode, active.warehouseCode] as [string, string];
    const [items, bals] = await Promise.all([
      db.inventory.where('[tenantCode+warehouseCode]').equals(pair).toArray(),
      db.stockBalances.where('[tenantCode+warehouseCode]').equals(pair).toArray(),
    ]);
    setInventory(items);
    setBalances(bals);
  }, []);

  const loadMovements = useCallback(async () => {
    const active = await getStockScope(await getActiveWarehouseCode());
    const movs = await db.inventoryMovements
      .where('[tenantCode+warehouseCode]')
      .equals([active.tenantCode, active.warehouseCode])
      .reverse()
      .limit(100)
      .toArray();
    setMovements(movs);
  }, []);

  useEffect(() => {
    loadInventory();
    loadMovements();
  }, [loadInventory, loadMovements]);

  /** Every physical dimension of one SKU inside the active warehouse. */
  const dimensionsFor = useCallback(
    (sku: string) =>
      balances
        .filter((b) => b.sku === sku)
        .sort(
          (a, b) =>
            (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31') ||
            a.location.localeCompare(b.location),
        ),
    [balances],
  );

  // AnomalySentinel + Oracle when inventory changes
  useEffect(() => {
    if (!inventory.length) {
      setAnomalyAlerts([]);
      setOraclePreview(null);
      return;
    }
    const mapped = inventory.map((i) => ({ sku: i.sku || i.product, stock: i.stock ?? 0 }));
    db.orders
      .limit(200)
      .toArray()
      .then((orders) => {
        const alerts = sentinel.scan(
          mapped,
          orders.map((o) => ({ status: o.status })),
        );
        setAnomalyAlerts(alerts.slice(0, 10));
      })
      .catch(() => setAnomalyAlerts([]));

    // Oracle on lowest-stock high-velocity item
    const candidate =
      inventory
        .filter((i) => (i.velocity || 'medium') === 'high')
        .sort((a, b) => (a.stock || 0) - (b.stock || 0))[0] || inventory[0];
    if (candidate) {
      try {
        oracle.seedFromInventory(candidate.stock || 0);
        const result = oracle.forecast(7);
        if (result) {
          setOraclePreview({ sku: candidate.sku || candidate.product, result });
        } else {
          setOraclePreview(null);
        }
      } catch {
        setOraclePreview(null);
      }
    }
  }, [inventory]);

  const categories = useMemo(() => [...new Set(inventory.map(i => i.category).filter((c): c is string => !!c))], [inventory]);

  const filteredInventory = useMemo(() => inventory.filter(item => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = item.sku.toLowerCase().includes(term) ||
      item.product.toLowerCase().includes(term) ||
      item.location.toLowerCase().includes(term) ||
      (item.category?.toLowerCase() || '').includes(term) ||
      (item.barcode?.toLowerCase() || '').includes(term) ||
      (item.rfidTag?.toLowerCase() || '').includes(term) ||
      (item.lotNumber?.toLowerCase() || '').includes(term) ||
      (item.batchNumber?.toLowerCase() || '').includes(term);
    const matchesCategory = !filterCategory || item.category === filterCategory;
    const matchesVelocity = !filterVelocity || item.velocity === filterVelocity;
    const matchesABC = !filterABC || getABCClass(item) === filterABC;
    return matchesSearch && matchesCategory && matchesVelocity && matchesABC;
  }), [inventory, searchTerm, filterCategory, filterVelocity, filterABC]);

  // Summary calculations
  const totalValue = useMemo(() => inventory.reduce((sum, i) => sum + (i.costPerUnit || 0) * (i.stock || 0), 0), [inventory]);
  const totalSkus = inventory.length;
  const totalUnits = useMemo(() => inventory.reduce((sum, i) => sum + (i.stock || 0), 0), [inventory]);
  const avgUnitCost = totalUnits > 0 ? totalValue / totalUnits : 0;

  const expiryStats = useMemo(() => {
    const expired = inventory.filter(i => {
      const days = daysUntilExpiry(i.expiryDate);
      return days !== null && days < 0;
    }).length;
    const within7 = inventory.filter(i => {
      const days = daysUntilExpiry(i.expiryDate);
      return days !== null && days >= 0 && days <= 7;
    }).length;
    const within30 = inventory.filter(i => {
      const days = daysUntilExpiry(i.expiryDate);
      return days !== null && days > 7 && days <= 30;
    }).length;
    return { expired, within7, within30 };
  }, [inventory]);

  const abcDistribution = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0 };
    inventory.forEach(i => { counts[getABCClass(i)]++; });
    return counts;
  }, [inventory]);

  const isLowStock = (item: InventoryItem) => {
    const threshold = item.reorderPoint ?? 10;
    // Reorder pressure is driven by SELLABLE stock: units already reserved or
    // quarantined cannot satisfy the next order.
    return (item.availableStock ?? item.stock ?? 0) <= threshold;
  };

  const lowStockCount = inventory.filter(isLowStock).length;

  const handleStockUpdate = async (id: number) => {
    if (!canAdjustStock) {
      setEditingId(null);
      return;
    }
    const newStock = parseInt(editStock, 10);
    if (isNaN(newStock) || newStock < 0) return;
    const prev = inventory.find((i) => i.id === id);
    if (!prev) {
      setEditingId(null);
      return;
    }

    const delta = newStock - (prev.stock || 0);
    if (delta === 0) {
      setEditingId(null);
      return;
    }

    // A rollup is never writable on its own: the correction is posted against a
    // named bin/lot dimension so the ledger, FEFO and the cloud stay consistent.
    const dims = dimensionsFor(prev.sku).filter((d) => d.stockStatus === 'AVAILABLE');
    const target = dims[0];
    if (!target) {
      setOverrideError(
        `${prev.sku} has no AVAILABLE bin dimension in ${scope.warehouseCode}. Open "Adjust" and name the bin and lot to correct.`,
      );
      setEditingId(null);
      return;
    }

    try {
      await upsertDimension({
        scope,
        sku: prev.sku,
        location: target.location,
        lotNumber: target.lotNumber,
        stockStatus: 'AVAILABLE',
        expiryDate: target.expiryDate ?? null,
        qtyDelta: delta,
        operator: user?.displayName || 'Supervisor',
        movementType: 'adjustment',
        note: `Stock correction ${prev.stock ?? 0} -> ${newStock} posted to ${target.location}/${target.lotNumber}`,
      });
      await logAction(
        'INVENTORY_STOCK_OVERRIDE',
        `Corrected ${prev.sku} from ${prev.stock ?? 0} to ${newStock} via ${target.location}/${target.lotNumber} (${scope.warehouseCode})`,
        user?.displayName || 'Supervisor',
      );
      void enqueueCloudOperation(
        'stock_movement',
        {
          sku: prev.sku,
          qtyDelta: delta,
          transactionType: 'adjustment',
          location: target.location,
          lotNumber: target.lotNumber,
          stockStatus: 'AVAILABLE',
          expiryDate: target.expiryDate ?? null,
          operator: user?.displayName || 'Supervisor',
          note: 'Stock correction from Inventory Hub',
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        },
        `adj:${scope.warehouseCode}:${prev.sku}:${target.location}:${target.lotNumber}:${Date.now()}`,
      );
      setOverrideError('');
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Correction refused');
    }

    setEditingId(null);
    loadInventory();
    loadMovements();
  };

  const handleAdjustment = async () => {
    if (!adjustItem || !adjustQty || !canAdjustStock) return;
    const delta = parseInt(adjustQty, 10);
    if (isNaN(delta) || delta === 0) return;

    // The operator must name the exact bin, lot and status being corrected.
    const bin = adjustBin.trim().toUpperCase();
    const lot = adjustLot.trim() || 'DEFAULT';
    if (!bin) {
      setOverrideError('Select or enter the bin this adjustment applies to.');
      return;
    }

    try {
      await upsertDimension({
        scope,
        sku: adjustItem.sku,
        location: bin,
        lotNumber: lot,
        stockStatus: adjustStatus,
        qtyDelta: delta,
        operator: user?.displayName || 'Supervisor',
        movementType: adjustStatus === 'AVAILABLE' ? 'adjustment' : 'qc_adjustment',
        note: `${delta > 0 ? '+' : ''}${delta} | ${adjustReason || 'Manual adjustment'}`,
      });
      await refreshInventoryRollup(adjustItem.sku, scope);
      await logAction(
        'INVENTORY_ADJUST',
        `Adjusted ${adjustItem.sku} by ${delta} at ${bin}/${lot} [${adjustStatus}] in ${scope.warehouseCode}: ${adjustReason || 'manual'}`,
        user?.displayName || 'Unknown',
      );
      void enqueueCloudOperation(
        'stock_movement',
        {
          sku: adjustItem.sku,
          qtyDelta: delta,
          transactionType: adjustStatus === 'AVAILABLE' ? 'adjustment' : 'qc_adjustment',
          location: bin,
          lotNumber: lot,
          stockStatus: adjustStatus,
          operator: user?.displayName || 'Supervisor',
          note: adjustReason || 'Manual adjustment',
          tenantCode: scope.tenantCode,
          warehouseCode: scope.warehouseCode,
        },
        `adj:${scope.warehouseCode}:${adjustItem.sku}:${bin}:${lot}:${adjustStatus}:${Date.now()}`,
      );
      setOverrideError('');
      setAdjustItem(null);
      setAdjustQty('');
      setAdjustReason('');
      setAdjustBin('');
      setAdjustLot('');
      setAdjustStatus('AVAILABLE');
      loadInventory();
      loadMovements();
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Adjustment refused');
    }
  };

  const getLocationZone = (location: string) => location.split('-')[0] || location;
  const getItemsInZone = (zone: string) => inventory.filter(item => getLocationZone(item.location).startsWith(zone));

  const itemMovements = (sku: string) => movements.filter(m => m.sku === sku).slice(0, 20);

  const onBarcodeScan = useCallback((code: string) => {
    const term = code.trim().toLowerCase();
    if (!term) {
      setScanMessage('Empty scan code');
      return;
    }
    const matches = inventory.filter(i =>
      (i.barcode?.toLowerCase() || '').includes(term) ||
      (i.rfidTag?.toLowerCase() || '').includes(term) ||
      i.sku.toLowerCase().includes(term) ||
      i.product.toLowerCase().includes(term)
    );
    if (matches.length === 1) {
      setSearchTerm(matches[0].sku);
      setDetailItem(matches[0]);
      setScanMessage(`Found: ${matches[0].sku}`);
    } else if (matches.length > 1) {
      setSearchTerm(code);
      setScanMessage(`${matches.length} matches found`);
    } else {
      setSearchTerm(code);
      setScanMessage('No match found');
    }
    setShowScanner(false);
    setTimeout(() => setScanMessage(null), 3000);
  }, [inventory]);

  const loadInboundForLot = useCallback(async (lotNumber?: string) => {
    if (!lotNumber) {
      setLotInboundRecords([]);
      return;
    }
    const records = await db.inbound.filter(r => r.lotNumber === lotNumber).toArray();
    setLotInboundRecords(records);
  }, []);

  useEffect(() => {
    if (detailItem) {
      loadInboundForLot(detailItem.lotNumber);
    } else {
      setLotInboundRecords([]);
    }
  }, [detailItem, loadInboundForLot]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Inventory Hub</h1>
        <p className="text-sm text-text-secondary mt-1">Real-time inventory with traceability, barcoding & FEFO</p>
      </div>

      {/* Value Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-panel rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-3.5 h-3.5 text-accent-green" />
            <span className="text-[10px] text-text-secondary uppercase tracking-widest">Total Value</span>
          </div>
          <p className="text-lg font-bold text-text-primary">${totalValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="glass-panel rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Package className="w-3.5 h-3.5 text-accent-sky" />
            <span className="text-[10px] text-text-secondary uppercase tracking-widest">Total SKUs</span>
          </div>
          <p className="text-lg font-bold text-text-primary">{totalSkus}</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-panel rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Box className="w-3.5 h-3.5 text-accent-yellow" />
            <span className="text-[10px] text-text-secondary uppercase tracking-widest">Total Units</span>
          </div>
          <p className="text-lg font-bold text-text-primary">{totalUnits.toLocaleString()}</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="glass-panel rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-text-secondary" />
            <span className="text-[10px] text-text-secondary uppercase tracking-widest">Avg Unit Cost</span>
          </div>
          <p className="text-lg font-bold text-text-primary">${avgUnitCost.toFixed(2)}</p>
        </motion.div>
      </div>

      {/* Neural Ops: AnomalySentinel + Oracle */}
      {(anomalyAlerts.length > 0 || oraclePreview) && (
        <div className="mb-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
          {oraclePreview && (
            <div className="glass-panel rounded-lg p-3 border border-accent-sky/20">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent-sky" />
                <span className="text-[10px] text-text-secondary uppercase tracking-widest">Oracle forecast · 7d</span>
              </div>
              <p className="text-xs text-white font-mono mb-1">{oraclePreview.sku}</p>
              <div className="flex flex-wrap gap-3 text-[11px]">
                <span>
                  Trend{' '}
                  <strong
                    className={
                      oraclePreview.result.trend === 'RISING'
                        ? 'text-emerald-400'
                        : oraclePreview.result.trend === 'DECLINING'
                          ? 'text-rose-400'
                          : 'text-white'
                    }
                  >
                    {oraclePreview.result.trend}
                  </strong>
                </span>
                <span>
                  Stockout{' '}
                  <strong
                    className={
                      oraclePreview.result.stockoutRisk === 'HIGH'
                        ? 'text-rose-400'
                        : oraclePreview.result.stockoutRisk === 'MEDIUM'
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                    }
                  >
                    {oraclePreview.result.stockoutRisk}
                  </strong>
                </span>
                <span className="text-text-secondary">
                  Reorder {oraclePreview.result.recommendedReorder} · conf{' '}
                  {Math.round(oraclePreview.result.confidence * 100)}%
                </span>
              </div>
            </div>
          )}
          {anomalyAlerts.length > 0 && (
            <div className="glass-panel rounded-lg p-3 border border-amber-500/20">
              <div className="flex items-center gap-2 mb-2">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[10px] text-text-secondary uppercase tracking-widest">
                  AnomalySentinel · {anomalyAlerts.length}
                </span>
              </div>
              <div className="space-y-1 max-h-24 overflow-auto">
                {anomalyAlerts.slice(0, 5).map((a, i) => (
                  <div key={`${a.sku}-${i}`} className="text-[11px] flex gap-2 items-start">
                    <span
                      className={
                        a.severity === 'CRITICAL'
                          ? 'text-rose-400 font-semibold'
                          : a.severity === 'HIGH'
                            ? 'text-amber-400 font-semibold'
                            : 'text-text-secondary'
                      }
                    >
                      {a.severity}
                    </span>
                    <span className="text-white/80 truncate">
                      <span className="font-mono text-accent-sky">{a.sku}</span> — {a.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expiry Alert Banner */}
      {(expiryStats.expired > 0 || expiryStats.within7 > 0 || expiryStats.within30 > 0) && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-4 p-3 glass-panel rounded-lg">
          <div className="flex items-center gap-4 flex-wrap">
            {expiryStats.expired > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-accent-red" />
                <span className="text-xs text-accent-red font-semibold">{expiryStats.expired} EXPIRED</span>
              </div>
            )}
            {expiryStats.within7 > 0 && (
              <div className="flex items-center gap-2">
                <Timer className="w-4 h-4 text-accent-yellow" />
                <span className="text-xs text-accent-yellow font-semibold">{expiryStats.within7} expiring &le;7 days</span>
              </div>
            )}
            {expiryStats.within30 > 0 && (
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-accent-sky" />
                <span className="text-xs text-accent-sky font-semibold">{expiryStats.within30} expiring &le;30 days</span>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Low Stock Banner */}
      {lowStockCount > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-4 p-3 bg-accent-red/10 border border-accent-red/20 rounded-md flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-accent-red flex-shrink-0" />
          <p className="text-xs text-accent-red"><strong>ACTION REQUIRED:</strong> {lowStockCount} SKU(s) at or below reorder point</p>
        </motion.div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {(['all', 'traceability', 'expiry'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${activeTab === tab ? 'bg-accent-sky/20 text-accent-sky border border-accent-sky/30' : 'bg-white/[0.02] text-text-secondary border border-white/[0.06]'}`}>
            {tab === 'all' ? 'All Inventory' : tab === 'traceability' ? 'Traceability' : 'Expiry Tracking'}
          </button>
        ))}
      </div>

      {/* Scanner Panel */}
      <AnimatePresence>
        {showScanner && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 overflow-hidden">
            <div className="glass-panel rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold">Barcode / RFID Scanner</span>
                <button onClick={() => setShowScanner(false)} className="p-1 text-text-secondary hover:text-text-primary transition-colors"><X className="w-4 h-4" /></button>
              </div>
              <BarcodeReader onScan={onBarcodeScan} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {scanMessage && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 p-2 glass-panel rounded-md flex items-center gap-2">
          <Barcode className="w-3.5 h-3.5 text-accent-sky" />
          <span className="text-xs text-text-primary">{scanMessage}</span>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Zone Map + Filters */}
        <div className="lg:col-span-2 glass-panel rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <MapPin className="w-4 h-4 text-accent-sky" />
            <h3 className="text-sm font-semibold text-text-primary">Zone Map</h3>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {ZONES.map(zone => {
              const items = getItemsInZone(zone);
              const totalStock = items.reduce((s, i) => s + (i.stock || 0), 0);
              const hasLow = items.some(i => isLowStock(i));
              const isHovered = hoveredLocation === zone;
              return (
                <motion.div key={zone} whileHover={{ scale: 1.05 }}
                  className={`aspect-square rounded-md border flex flex-col items-center justify-center cursor-pointer transition-all ${
                    isHovered ? 'bg-accent-sky/20 border-accent-sky/40' : hasLow ? 'bg-accent-red/5 border-accent-red/20' : items.length > 0 ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-transparent border-white/[0.04]'
                  }`}
                  onMouseEnter={() => setHoveredLocation(zone)} onMouseLeave={() => setHoveredLocation(null)}>
                  <span className="text-[10px] text-text-secondary font-mono">{zone}</span>
                  <span className={`text-sm font-bold ${hasLow ? 'text-accent-red' : 'text-text-primary'}`}>{totalStock}</span>
                  <span className="text-[9px] text-text-secondary">{items.length} SKUs</span>
                </motion.div>
              );
            })}
          </div>

          {/* ABC Distribution */}
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">ABC Classification</p>
            <div className="flex gap-2 mb-2">
              {(['A', 'B', 'C'] as const).map(cls => (
                <button key={cls} onClick={() => setFilterABC(filterABC === cls ? null : cls)}
                  className={`flex-1 py-1.5 text-[10px] rounded-md border transition-all font-semibold ${filterABC === cls ? 'bg-accent-sky/20 text-accent-sky border-accent-sky/30' : 'bg-white/[0.02] text-text-secondary border-white/[0.06]'}`}>
                  {cls} ({abcDistribution[cls]})
                </button>
              ))}
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.03]">
              <div className="bg-accent-sky h-full" style={{ width: `${totalSkus ? (abcDistribution.A / totalSkus) * 100 : 0}%` }} />
              <div className="bg-accent-yellow h-full" style={{ width: `${totalSkus ? (abcDistribution.B / totalSkus) * 100 : 0}%` }} />
              <div className="bg-white/20 h-full" style={{ width: `${totalSkus ? (abcDistribution.C / totalSkus) * 100 : 0}%` }} />
            </div>
          </div>

          {/* Category Filter */}
          {categories.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/[0.06]">
              <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">Filter by Category</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setFilterCategory(null)} className={`text-[10px] px-2 py-1 rounded-md transition-all ${!filterCategory ? 'bg-accent-sky/20 text-accent-sky' : 'bg-white/[0.03] text-text-secondary'}`}>All</button>
                {categories.map((cat: string) => (
                  <button key={cat} onClick={() => setFilterCategory(cat === filterCategory ? null : cat)} className={`text-[10px] px-2 py-1 rounded-md transition-all ${filterCategory === cat ? 'bg-accent-sky/20 text-accent-sky' : 'bg-white/[0.03] text-text-secondary'}`}>{cat}</button>
                ))}
              </div>
            </div>
          )}

          {/* Velocity Filter */}
          <div className="mt-3">
            <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">Filter by Velocity</p>
            <div className="flex gap-1.5">
              {(['high', 'medium', 'low'] as const).map(v => (
                <button key={v} onClick={() => setFilterVelocity(filterVelocity === v ? null : v)} className={`text-[10px] px-2 py-1 rounded-md transition-all capitalize ${filterVelocity === v ? 'bg-accent-sky/20 text-accent-sky' : 'bg-white/[0.03] text-text-secondary'}`}>{v}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Master Stock Table / Traceability / Expiry */}
        <div className="lg:col-span-3 glass-panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-accent-sky" />
              <h3 className="text-sm font-semibold text-text-primary">
                {activeTab === 'all' ? 'Master Stock List' : activeTab === 'traceability' ? 'Traceability & Lots' : 'Expiry Tracking'}
              </h3>
              <span className="text-[10px] text-text-secondary">{filteredInventory.length} items</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowScanner(s => !s)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-accent-sky/10 text-accent-sky border border-accent-sky/20 hover:bg-accent-sky/20 transition-all"
              >
                <ScanLine className="w-3.5 h-3.5" />
                Scan Barcode
              </button>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-text-secondary absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search SKU, barcode, lot, RFID..."
                  className="bg-white/[0.03] border border-white/[0.08] rounded-md pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-sky transition-colors w-56" />
              </div>
            </div>
          </div>

          {activeTab === 'all' && (() => {
            const totalRows = filteredInventory.length;
            const startIdx = Math.max(0, Math.floor(tableScrollTop / ROW_HEIGHT) - 6);
            const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 12;
            const endIdx = Math.min(totalRows, startIdx + visibleCount);
            const topPad = startIdx * ROW_HEIGHT;
            const bottomPad = Math.max(0, (totalRows - endIdx) * ROW_HEIGHT);
            const slice = filteredInventory.slice(startIdx, endIdx);

            return (
              <div
                className="overflow-auto max-h-[480px]"
                onScroll={(e) => setTableScrollTop(e.currentTarget.scrollTop)}
              >
                <table className="w-full">
                  <thead className="sticky top-0 bg-[#0d0d12] z-10">
                    <tr className="text-[10px] text-text-secondary uppercase tracking-widest border-b border-white/[0.06]">
                      <th className="text-left py-2 px-2">SKU</th>
                      <th className="text-left py-2 px-2">Product</th>
                      <th className="text-center py-2 px-2">Stock</th>
                      <th className="text-center py-2 px-2">ABC</th>
                      <th className="text-center py-2 px-2">Location</th>
                      <th className="text-center py-2 px-2">Velocity</th>
                      <th className="text-center py-2 px-2">Value</th>
                      <th className="text-center py-2 px-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topPad > 0 && (
                      <tr style={{ height: topPad }}>
                        <td colSpan={8} />
                      </tr>
                    )}
                    {slice.map((item) => {
                      const low = isLowStock(item);
                      const abc = getABCClass(item);
                      const itemValue = (item.costPerUnit || 0) * (item.stock || 0);
                      return (
                        <tr key={item.id ?? item.sku} style={{ height: ROW_HEIGHT }} className={`border-b border-white/[0.04] transition-colors ${low ? 'animate-pulse-red' : 'hover:bg-white/[0.02]'}`}>
                          <td className="py-2 px-2 text-xs font-mono text-text-primary">
                            <div>{item.sku}</div>
                            {item.barcode && <div className="text-[9px] text-text-secondary flex items-center gap-0.5"><Barcode className="w-2.5 h-2.5" />{item.barcode}</div>}
                          </td>
                          <td className="py-2 px-2 text-xs text-text-primary max-w-[120px] truncate">
                            <div>{item.product}</div>
                            {item.category && <div className="text-[9px] text-text-secondary">{item.category}</div>}
                          </td>
                          <td className="py-2 px-2 text-center">
                            {editingId === item.id && canAdjustStock ? (
                              <input type="number" value={editStock} onChange={(e) => setEditStock(e.target.value)} onBlur={() => handleStockUpdate(item.id!)} onKeyDown={(e) => e.key === 'Enter' && handleStockUpdate(item.id!)}
                                className="w-14 bg-transparent border-b border-accent-sky text-center text-xs text-text-primary font-mono focus:outline-none" autoFocus />
                            ) : (
                              <button
                                type="button"
                                disabled={!canAdjustStock}
                                onClick={() => { if (canAdjustStock) { setEditingId(item.id!); setEditStock(String(item.stock || 0)); } }}
                                className={`text-xs font-mono font-semibold ${low ? 'text-accent-red' : 'text-text-primary'} ${!canAdjustStock ? 'cursor-default' : ''}`}
                              >
                                {item.stock}
                              </button>
                            )}
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className={`text-[10px] font-bold ${getABCColor(abc)}`}>{abc}</span>
                          </td>
                          <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.location}</td>
                          <td className="py-2 px-2 text-center">
                            <span className={`text-[9px] font-semibold capitalize ${VELOCITY_COLORS[item.velocity || 'low']}`}>{item.velocity || 'low'}</span>
                          </td>
                          <td className="py-2 px-2 text-center text-[10px] font-mono text-accent-green">${itemValue.toLocaleString()}</td>
                          <td className="py-2 px-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button onClick={() => setDetailItem(item)} className="p-1 text-text-secondary hover:text-accent-sky transition-colors" title="Traceability"><History className="w-3 h-3" /></button>
                              {canAdjustStock && (
                                <button onClick={() => setAdjustItem(item)} className="p-1 text-text-secondary hover:text-accent-yellow transition-colors" title="Adjust Stock (Supervisor/Admin)"><Plus className="w-3 h-3" /></button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {bottomPad > 0 && (
                      <tr style={{ height: bottomPad }}>
                        <td colSpan={8} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {activeTab === 'traceability' && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-text-secondary uppercase tracking-widest border-b border-white/[0.06]">
                    <th className="text-left py-2 px-2">SKU</th>
                    <th className="text-left py-2 px-2">Lot/Batch</th>
                    <th className="text-center py-2 px-2">Barcode</th>
                    <th className="text-center py-2 px-2">RFID</th>
                    <th className="text-center py-2 px-2">Dims (cm)</th>
                    <th className="text-center py-2 px-2">Weight</th>
                    <th className="text-center py-2 px-2">FEFO</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInventory.filter(i => i.lotNumber || i.batchNumber || i.barcode || i.rfidTag).map((item) => (
                    <tr key={item.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 px-2 text-xs font-mono text-text-primary">{item.sku}</td>
                      <td className="py-2 px-2 text-xs">
                        {item.lotNumber && <div className="text-accent-yellow text-[10px] font-mono">Lot: {item.lotNumber}</div>}
                        {item.batchNumber && <div className="text-accent-sky text-[10px] font-mono">Batch: {item.batchNumber}</div>}
                      </td>
                      <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.barcode || '-'}</td>
                      <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.rfidTag || '-'}</td>
                      <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">
                        {item.length && item.width && item.height ? `${item.length}×${item.width}×${item.height}` : '-'}
                      </td>
                      <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.weight ? `${item.weight}kg` : '-'}</td>
                      <td className="py-2 px-2 text-center">
                        <span className={`text-[10px] font-bold ${(item.fefoPriority || 0) > 3 ? 'text-accent-red' : 'text-text-secondary'}`}>{item.fefoPriority || '-'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredInventory.filter(i => i.lotNumber || i.batchNumber || i.barcode || i.rfidTag).length === 0 && (
                <p className="text-xs text-text-secondary text-center py-8">No traceable items found</p>
              )}
            </div>
          )}

          {activeTab === 'expiry' && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-text-secondary uppercase tracking-widest border-b border-white/[0.06]">
                    <th className="text-left py-2 px-2">SKU</th>
                    <th className="text-left py-2 px-2">Product</th>
                    <th className="text-center py-2 px-2">Lot</th>
                    <th className="text-center py-2 px-2">Mfg Date</th>
                    <th className="text-center py-2 px-2">Expiry</th>
                    <th className="text-center py-2 px-2">Days Left</th>
                    <th className="text-center py-2 px-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInventory.filter(i => i.expiryDate).sort((a, b) => {
                    const da = daysUntilExpiry(a.expiryDate) ?? 999;
                    const db = daysUntilExpiry(b.expiryDate) ?? 999;
                    return da - db;
                  }).map((item) => {
                    const days = daysUntilExpiry(item.expiryDate);
                    const isExpired = days !== null && days < 0;
                    const isCritical = days !== null && days >= 0 && days <= 7;
                    const isWarning = days !== null && days > 7 && days <= 30;
                    return (
                      <tr key={item.id} className={`border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${isExpired ? 'bg-accent-red/5' : isCritical ? 'bg-accent-yellow/5' : ''}`}>
                        <td className="py-2 px-2 text-xs font-mono text-text-primary">{item.sku}</td>
                        <td className="py-2 px-2 text-xs text-text-primary max-w-[120px] truncate">{item.product}</td>
                        <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.lotNumber || '-'}</td>
                        <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.manufacturingDate || '-'}</td>
                        <td className="py-2 px-2 text-center text-[10px] font-mono text-text-secondary">{item.expiryDate}</td>
                        <td className="py-2 px-2 text-center">
                          <span className={`text-xs font-bold font-mono ${isExpired ? 'text-accent-red' : isCritical ? 'text-accent-yellow' : isWarning ? 'text-accent-sky' : 'text-accent-green'}`}>
                            {days === null ? '-' : days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ${isExpired ? 'bg-accent-red/20 text-accent-red' : isCritical ? 'bg-accent-yellow/20 text-accent-yellow' : isWarning ? 'bg-accent-sky/20 text-accent-sky' : 'bg-accent-green/20 text-accent-green'}`}>
                            {isExpired ? 'EXPIRED' : isCritical ? 'CRITICAL' : isWarning ? 'WARNING' : 'OK'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredInventory.filter(i => i.expiryDate).length === 0 && (
                <p className="text-xs text-text-secondary text-center py-8">No expiry-tracked items</p>
              )}
            </div>
          )}

          {filteredInventory.length === 0 && activeTab === 'all' && (
            <p className="text-xs text-text-secondary text-center py-8">No items found</p>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      <AnimatePresence>
        {detailItem && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setDetailItem(null)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="glass-panel rounded-lg p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-text-primary">{detailItem.sku}</h3>
                  <p className="text-sm text-text-secondary">{detailItem.product}</p>
                </div>
                <button onClick={() => setDetailItem(null)} className="p-1 text-text-secondary hover:text-text-primary"><X className="w-5 h-5" /></button>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-white/[0.02] rounded-md p-3">
                  <p className="text-[10px] text-text-secondary uppercase tracking-widest">On hand / sellable</p>
                  <p className="text-lg font-bold text-text-primary">
                    {detailItem.stock ?? 0}
                    <span className="text-accent-green text-sm"> / {detailItem.availableStock ?? detailItem.stock ?? 0}</span>
                  </p>
                </div>
                <div className="bg-white/[0.02] rounded-md p-3">
                  <p className="text-[10px] text-text-secondary uppercase tracking-widest">Bins / lots</p>
                  <p className="text-lg font-bold text-text-primary font-mono">
                    {detailItem.binCount ?? dimensionsFor(detailItem.sku).length}
                    <span className="text-text-secondary text-sm"> / {detailItem.lotNumbers?.length ?? (detailItem.lotNumber ? 1 : 0)}</span>
                  </p>
                </div>
                <div className="bg-white/[0.02] rounded-md p-3">
                  <p className="text-[10px] text-text-secondary uppercase tracking-widest">Value</p>
                  <p className="text-lg font-bold text-accent-green">${((detailItem.costPerUnit || 0) * (detailItem.stock || 0)).toLocaleString()}</p>
                </div>
                <div className="bg-white/[0.02] rounded-md p-3">
                  <p className="text-[10px] text-text-secondary uppercase tracking-widest">ABC Class</p>
                  <p className={`text-lg font-bold ${getABCColor(getABCClass(detailItem))}`}>{getABCClass(detailItem)}</p>
                </div>
              </div>

              {/* Physical stock dimensions — the authoritative granularity view */}
              <div className="mb-4">
                <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2 flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  Stock dimensions — {scope.warehouseCode}
                </p>
                {dimensionsFor(detailItem.sku).length === 0 ? (
                  <p className="text-xs text-text-secondary py-2">
                    No balance rows for this SKU in {scope.warehouseCode || 'the active warehouse'}. Stock shown above is
                    a local rollup only.
                  </p>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                    {dimensionsFor(detailItem.sku).map((d) => {
                      const sellable = Math.max(0, d.onHandQty - d.reservedQty - d.quarantineQty);
                      const expired = d.expiryDate ? daysUntilExpiry(d.expiryDate) ?? 0 : null;
                      return (
                        <div
                          key={`${d.location}|${d.lotNumber}|${d.stockStatus}|${d.serialNumber ?? ''}`}
                          className={`flex items-center gap-2 text-[10px] p-2 rounded-md border ${
                            d.stockStatus === 'AVAILABLE'
                              ? 'bg-white/[0.02] border-white/[0.05]'
                              : 'bg-accent-red/5 border-accent-red/15'
                          }`}
                        >
                          <span className="font-mono text-text-primary font-semibold">{d.location}</span>
                          <span className="font-mono text-text-secondary">LOT {d.lotNumber}</span>
                          <span
                            className={`font-mono ${
                              d.stockStatus === 'AVAILABLE'
                                ? 'text-accent-green'
                                : d.stockStatus === 'QUARANTINE'
                                  ? 'text-accent-yellow'
                                  : 'text-accent-red'
                            }`}
                          >
                            {d.stockStatus}
                          </span>
                          {d.expiryDate && (
                            <span className={`font-mono ${expired !== null && expired < 0 ? 'text-accent-red' : 'text-text-secondary'}`}>
                              exp {d.expiryDate}
                            </span>
                          )}
                          {d.serialNumber && <span className="font-mono text-accent-sky">SN {d.serialNumber}</span>}
                          <span className="ml-auto font-mono text-text-primary">
                            {sellable} sellable / {d.onHandQty} on hand
                            {d.reservedQty > 0 ? ` · ${d.reservedQty} res` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {dimensionsFor(detailItem.sku).filter((d) => d.stockStatus === 'AVAILABLE').length > 1 && (
                  <p className="text-[10px] text-accent-sky/80 mt-1.5">
                    Multi-bin SKU: FEFO will consume the soonest usable expiry first, then the lowest pick sequence.
                  </p>
                )}
              </div>

              <div className="space-y-2 mb-4">
                <p className="text-[10px] text-text-secondary uppercase tracking-widest">Traceability</p>
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="flex items-center gap-1"><Barcode className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Barcode:</span> <span className="text-text-primary font-mono">{detailItem.barcode || '-'}</span></div>
                  <div className="flex items-center gap-1"><Tag className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">RFID:</span> <span className="text-text-primary font-mono">{detailItem.rfidTag || '-'}</span></div>
                  <div className="flex items-center gap-1"><Hash className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Lot:</span> <span className="text-text-primary font-mono">{detailItem.lotNumber || '-'}</span></div>
                  <div className="flex items-center gap-1"><Hash className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Batch:</span> <span className="text-text-primary font-mono">{detailItem.batchNumber || '-'}</span></div>
                  <div className="flex items-center gap-1"><Ruler className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Dims:</span> <span className="text-text-primary font-mono">{detailItem.length && detailItem.width && detailItem.height ? `${detailItem.length}×${detailItem.width}×${detailItem.height}cm` : '-'}</span></div>
                  <div className="flex items-center gap-1"><Box className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Weight:</span> <span className="text-text-primary font-mono">{detailItem.weight ? `${detailItem.weight}kg` : '-'}</span></div>
                  <div className="flex items-center gap-1"><Calendar className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Mfg:</span> <span className="text-text-primary font-mono">{detailItem.manufacturingDate || '-'}</span></div>
                  <div className="flex items-center gap-1"><Timer className="w-3 h-3 text-text-secondary" /><span className="text-text-secondary">Expiry:</span> <span className="text-text-primary font-mono">{detailItem.expiryDate || '-'}</span></div>
                </div>
              </div>

              {/* Lot Traceability Drill-down */}
              {detailItem.lotNumber && (
                <div className="mb-4">
                  <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Truck className="w-3 h-3" />
                    Lot Receipt History — {detailItem.lotNumber}
                  </p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {lotInboundRecords.length === 0 ? (
                      <p className="text-xs text-text-secondary py-2">No inbound receipts found for this lot</p>
                    ) : (
                      lotInboundRecords.map((rec, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px] p-2 bg-white/[0.02] rounded-md">
                          <span className={`font-semibold capitalize ${rec.qcStatus === 'passed' ? 'text-accent-green' : rec.qcStatus === 'failed' ? 'text-accent-red' : 'text-accent-yellow'}`}>{rec.qcStatus}</span>
                          <span className="text-text-primary font-mono">{rec.qty > 0 ? '+' : ''}{rec.qty}</span>
                          <span className="text-text-secondary">{rec.supplier || '—'}</span>
                          {rec.poNumber && <span className="text-accent-sky font-mono">PO:{rec.poNumber}</span>}
                          <span className="text-text-secondary ml-auto">{new Date(rec.receivedAt).toLocaleDateString()}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div>
                <p className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">Recent Movements</p>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {itemMovements(detailItem.sku).length === 0 ? (
                    <p className="text-xs text-text-secondary">No movement history</p>
                  ) : (
                    itemMovements(detailItem.sku).map((mov, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px] p-2 bg-white/[0.02] rounded-md">
                        <span className={`font-semibold capitalize ${mov.type === 'inbound' ? 'text-accent-green' : mov.type === 'outbound' ? 'text-accent-sky' : 'text-text-secondary'}`}>{mov.type}</span>
                        <span className="text-text-primary font-mono">{mov.quantity > 0 ? '+' : ''}{mov.quantity}</span>
                        <span className="text-text-secondary">{mov.operator}</span>
                        <span className="text-text-secondary ml-auto">{new Date(mov.timestamp).toLocaleDateString()}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Adjust Modal */}
      <AnimatePresence>
        {adjustItem && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setAdjustItem(null)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="glass-panel rounded-lg p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-text-primary">Adjust Stock</h3>
                <button onClick={() => setAdjustItem(null)} className="p-1 text-text-secondary hover:text-text-primary"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-xs text-text-secondary mb-2">
                {adjustItem.sku} — on hand <span className="text-text-primary font-bold">{adjustItem.stock ?? 0}</span>
                {' · '}sellable <span className="text-accent-green font-bold">{adjustItem.availableStock ?? adjustItem.stock ?? 0}</span>
                {' · '}reserved <span className="text-accent-yellow font-bold">{adjustItem.reservedStock ?? 0}</span>
                {' · '}blocked <span className="text-accent-red font-bold">{adjustItem.quarantineStock ?? 0}</span>
              </p>
              <p className="text-[10px] text-text-secondary/70 font-mono mb-4">{scope.warehouseCode} · {scope.tenantCode}</p>

              {/* Physical dimensions: the adjustment must name one of them. */}
              <div className="mb-3">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1">Bin / lot dimension</label>
                {dimensionsFor(adjustItem.sku).length === 0 ? (
                  <input
                    type="text"
                    value={adjustBin}
                    onChange={(e) => setAdjustBin(e.target.value.toUpperCase())}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-sky"
                    placeholder="PHONE-A-01-01"
                  />
                ) : (
                  <select
                    value={adjustBin ? `${adjustBin}|${adjustLot}` : ''}
                    onChange={(e) => {
                      const [bin, lot] = e.target.value.split('|');
                      setAdjustBin(bin || '');
                      setAdjustLot(lot || '');
                    }}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-sky"
                  >
                    <option value="" className="bg-[#0c0c14]">Select a bin / lot…</option>
                    {dimensionsFor(adjustItem.sku).map((d) => (
                      <option key={`${d.location}|${d.lotNumber}|${d.stockStatus}`} value={`${d.location}|${d.lotNumber}`} className="bg-[#0c0c14]">
                        {d.location} · LOT {d.lotNumber} · {d.stockStatus} · {d.onHandQty} on hand
                        {d.expiryDate ? ` · exp ${d.expiryDate}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <input
                    type="text"
                    value={adjustBin}
                    onChange={(e) => setAdjustBin(e.target.value.toUpperCase())}
                    className="bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-sky"
                    placeholder="BIN CODE"
                  />
                  <input
                    type="text"
                    value={adjustLot}
                    onChange={(e) => setAdjustLot(e.target.value.toUpperCase())}
                    className="bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-sky"
                    placeholder="LOT"
                  />
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1">Stock status</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['AVAILABLE', 'QUARANTINE', 'DAMAGED'] as const).map((st) => (
                    <button
                      key={st}
                      onClick={() => setAdjustStatus(st)}
                      className={`px-2 py-1.5 rounded-md text-[10px] font-mono border transition-all ${
                        adjustStatus === st
                          ? 'bg-accent-sky/20 border-accent-sky/40 text-accent-sky'
                          : 'bg-white/[0.02] border-white/[0.06] text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1">Adjustment (+/-)</label>
                <input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-sky" placeholder="+5 or -3" />
              </div>
              <div className="mb-4">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1">Reason</label>
                <input type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-sky" placeholder="Damage, found, etc." />
              </div>
              {overrideError && (
                <p className="text-[11px] text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-md px-3 py-2 mb-3">{overrideError}</p>
              )}
              <button
                onClick={handleAdjustment}
                disabled={!adjustBin.trim()}
                className="w-full py-2.5 bg-accent-sky text-void font-semibold text-sm rounded-md hover:bg-accent-sky/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Apply Adjustment
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
