import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import {
  Package,
  PackageOpen,
  ScanBarcode,
  Truck,
  Camera,
  Sheet,
  BarChart3,
  Fingerprint,
  Layers,
  Barcode,
  ArrowRight,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Zap,
  Activity,
  FileText,
  Smartphone,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import KineticCounter from '@/components/KineticCounter';

/**
 * Lite WMS — Workflow Summary
 * Single pane for day-to-day / instant order processing.
 * Guides operators through: Inbound → Inventory/Serial → Batch Pick → Shipping → Posting → Ozon
 */

const workflowSteps = [
  {
    id: 'inbound',
    label: 'Inbound',
    description: 'Receive goods, scan ASN / cartons',
    path: '/inbound',
    icon: Package,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/30',
  },
  {
    id: 'inventory',
    label: 'Inventory Hub',
    description: 'Stock levels, locations, adjustments',
    path: '/inventory',
    icon: PackageOpen,
    color: 'text-sky-400',
    bg: 'bg-sky-500/10 border-sky-500/30',
  },
  {
    id: 'serial',
    label: 'Serial Tracking',
    description: 'IMEI / S/N capture & verification',
    path: '/serial-tracking',
    icon: Fingerprint,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/30',
  },
  {
    id: 'scanner',
    label: 'Barcode Scanner',
    description: 'Live camera / handheld scan',
    path: '/barcode-scanner',
    icon: ScanBarcode,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/30',
  },
  {
    id: 'batch',
    label: 'Batch Pick',
    description: 'Wave / batch pick for same-day',
    path: '/batch-pick',
    icon: Layers,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/30',
  },
  {
    id: 'shipping',
    label: 'Shipping',
    description: 'Labels, packing lists, carriers',
    path: '/shipping',
    icon: Truck,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10 border-cyan-500/30',
  },
  {
    id: 'posting',
    label: 'Posting Tracker',
    description: 'Marketplace post / status photos',
    path: '/posting-tracker',
    icon: Camera,
    color: 'text-rose-400',
    bg: 'bg-rose-500/10 border-rose-500/30',
  },
  {
    id: 'ozon',
    label: 'Ozon Sheets',
    description: 'Sheet sync & marketplace ops',
    path: '/ozon-sheets',
    icon: Sheet,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/30',
  },
];

const utilityLinks = [
  { label: 'Analytics', path: '/analytics', icon: BarChart3 },
  { label: 'Barcode Generator', path: '/barcode-generator', icon: Barcode },
  { label: 'PDF Sequencer', path: '/pdf-sequencer', icon: ScanBarcode },
  { label: 'Templates', path: '/templates', icon: FileText },
  { label: 'SIM / IMEI', path: '/sim-manager', icon: Smartphone },
];

export default function WorkflowSummary() {
  const navigate = useNavigate();

  // Live counts from IndexedDB (graceful if tables missing)
  const inventoryCount = useLiveQuery(async () => {
    try {
      return await db.inventory.count();
    } catch {
      return 0;
    }
  }, []) ?? 0;

  const orderCount = useLiveQuery(async () => {
    try {
      return await db.orders.count();
    } catch {
      return 0;
    }
  }, []) ?? 0;

  const serialCount = useLiveQuery(async () => {
    try {
      return await db.serialNumbers.count();
    } catch {
      return 0;
    }
  }, []) ?? 0;

  const shipmentCount = useLiveQuery(async () => {
    try {
      return await db.shippingLabels.count();
    } catch {
      return 0;
    }
  }, []) ?? 0;

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-5 h-5 text-accent-sky" />
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Lite WMS — Instant Order Workflow
            </h1>
          </div>
          <p className="text-sm text-text-secondary">
            Day-to-day manual processing · {todayLabel}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {utilityLinks.map((u) => (
            <Button
              key={u.path}
              variant="outline"
              size="sm"
              className="gap-1.5 border-white/10 hover:border-accent-sky/40"
              onClick={() => navigate(u.path)}
            >
              <u.icon className="w-3.5 h-3.5" />
              {u.label}
            </Button>
          ))}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-surface/60 border-white/5">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary">Inventory SKUs</span>
              <PackageOpen className="w-3.5 h-3.5 text-sky-400" />
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
              <KineticCounter value={inventoryCount} size={28} />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-surface/60 border-white/5">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary">Open Orders</span>
              <Activity className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
              <KineticCounter value={orderCount} size={28} />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-surface/60 border-white/5">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary">Serials Logged</span>
              <Fingerprint className="w-3.5 h-3.5 text-violet-400" />
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
              <KineticCounter value={serialCount} size={28} />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-surface/60 border-white/5">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary">Shipments</span>
              <Truck className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
              <KineticCounter value={shipmentCount} size={28} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Process flow guide */}
      <Card className="bg-surface/40 border-white/5 overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Recommended daily flow
          </CardTitle>
          <CardDescription>
            Follow left → right for same-day / instant marketplace orders. Each step opens the full operational screen.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary mb-4">
            <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-400">
              <Clock className="w-3 h-3" /> Start of shift
            </Badge>
            <ArrowRight className="w-3.5 h-3.5 opacity-40" />
            <span>Receive</span>
            <ArrowRight className="w-3.5 h-3.5 opacity-40" />
            <span>Locate / Serial</span>
            <ArrowRight className="w-3.5 h-3.5 opacity-40" />
            <span>Batch pick</span>
            <ArrowRight className="w-3.5 h-3.5 opacity-40" />
            <span>Ship & post</span>
            <ArrowRight className="w-3.5 h-3.5 opacity-40" />
            <Badge variant="outline" className="gap-1 border-sky-500/30 text-sky-400">
              Done
            </Badge>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {workflowSteps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => navigate(step.path)}
                  className={`group relative text-left rounded-xl border p-4 transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-black/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-sky ${step.bg}`}
                >
                  <div className="absolute top-3 right-3 text-[10px] font-mono text-white/30">
                    {String(idx + 1).padStart(2, '0')}
                  </div>
                  <div className={`mb-3 ${step.color}`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="font-medium text-sm text-white group-hover:text-accent-sky transition-colors">
                    {step.label}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-text-secondary">
                    {step.description}
                  </p>
                  <div className="mt-3 flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/40 group-hover:text-accent-sky/80">
                    Open <ArrowRight className="w-3 h-3" />
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Quick tips / edge cases */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="bg-surface/40 border-white/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Instant order checklist
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-text-secondary space-y-2">
            <ul className="space-y-1.5 list-disc list-inside marker:text-accent-sky/60">
              <li>Confirm stock in <strong className="text-white/80">Inventory Hub</strong> before accepting rush orders.</li>
              <li>Capture serials / IMEIs in <strong className="text-white/80">Serial Tracking</strong> at pick or pack.</li>
              <li>Use <strong className="text-white/80">Batch Pick</strong> for multi-order waves to cut travel time.</li>
              <li>Generate shipping labels in <strong className="text-white/80">Shipping</strong>, then log post photos in <strong className="text-white/80">Posting Tracker</strong>.</li>
              <li>Keep Ozon marketplace rows in sync via <strong className="text-white/80">Ozon Sheets</strong>.</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-surface/40 border-white/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              Common issues
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-text-secondary space-y-2">
            <ul className="space-y-1.5 list-disc list-inside marker:text-rose-400/60">
              <li>Scanner not reading → switch to <strong className="text-white/80">Barcode Scanner</strong> camera mode or regenerate labels.</li>
              <li>Wrong location stock → adjust in Inventory Hub; re-run serial verification if required.</li>
              <li>Marketplace status stuck → re-check Posting Tracker + Ozon Sheets sync.</li>
              <li>Missing barcodes for new locations → use <strong className="text-white/80">Barcode Generator</strong>.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <p className="text-center text-[10px] text-text-secondary/60 pt-2">
        YESI Lite WMS · Manual workflow for instant & same-day order processing · Offline-capable (Dexie)
      </p>
    </div>
  );
}
