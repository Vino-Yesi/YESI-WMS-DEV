import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/lib/auth';
import { seedDatabase, DEMO_SEED_ENABLED, requiresBootstrap } from '@/lib/db';
import { startHybridSyncEngine, setActiveWarehouseCode, migrateLegacyOutbox } from '@/lib/supabaseSync';
import { runtimeConfig } from '@/lib/config';
import { useEffect, useState, Suspense, lazy, type ComponentType } from 'react';
import Layout from '@/components/Layout';
import OfflineIndicator from '@/components/OfflineIndicator';
import InstallPrompt from '@/components/InstallPrompt';
import CommandPalette from '@/components/CommandPalette';
import AIAssistant from '@/components/AIAssistant';
import { RouteErrorBoundary } from '@/components/ErrorBoundary';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
import Login from '@/pages/Login';

// Core & Executive
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const DailyManual = lazy(() => import('@/pages/DailyManual'));
const WorkflowSummary = lazy(() => import('@/pages/WorkflowSummary'));
const CloudMonitor = lazy(() => import('@/pages/CloudMonitor'));
const GuardianDashboard = lazy(() => import('@/pages/GuardianDashboard'));

// Inbound Domain (04)
const DockManagement = lazy(() => import('@/pages/DockManagement'));
const InboundReceiving = lazy(() => import('@/pages/InboundReceiving'));
const QCManagement = lazy(() => import('@/pages/QCManagement'));
const PutawayManagement = lazy(() => import('@/pages/PutawayManagement'));

// Inventory & Location Domains (02, 03, 05, 07)
const InventoryHub = lazy(() => import('@/pages/InventoryHub'));
const SerialTracking = lazy(() => import('@/pages/SerialTracking'));
const CycleCount = lazy(() => import('@/pages/CycleCount'));
const Replenishment = lazy(() => import('@/pages/Replenishment'));
const LocationBarcodeGenerator = lazy(() => import('@/pages/LocationBarcodeGenerator'));
const BarcodeScanner = lazy(() => import('@/pages/BarcodeScanner'));

// Outbound, Transport & Returns Domains (06, 08, 09)
const PickPack = lazy(() => import('@/pages/PickPack'));
const BatchPickCenter = lazy(() => import('@/pages/BatchPickCenter'));
const Shipping = lazy(() => import('@/pages/Shipping'));
const PostingTracker = lazy(() => import('@/pages/PostingTracker'));
const Returns = lazy(() => import('@/pages/Returns'));

// Label, Floor Tools, Integrations, Labor & Admin (10, 11, 12)
const PDFSequencer = lazy(() => import('@/pages/PDFSequencer'));
const Templates = lazy(() => import('@/pages/Templates'));
const BulkConverter = lazy(() => import('@/pages/BulkConverter'));
const Auditor = lazy(() => import('@/pages/Auditor'));
const SIMManager = lazy(() => import('@/pages/SIMManager'));
const GSheetHub = lazy(() => import('@/pages/GSheetHub'));
const OzonSheetsHub = lazy(() => import('@/pages/OzonSheetsHub'));
const IntegrationHub = lazy(() => import('@/pages/IntegrationHub'));
const LaborManagement = lazy(() => import('@/pages/LaborManagement'));
const Analytics = lazy(() => import('@/pages/Analytics'));
const Memory = lazy(() => import('@/pages/Memory'));
const UserManagement = lazy(() => import('@/pages/UserManagement'));
const Settings = lazy(() => import('@/pages/Settings'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="w-7 h-7 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AccessDenied({ title, permission }: { title?: string; permission: string }) {
  const { user } = useAuth();
  return (
    <div className="max-w-lg mx-auto mt-16 glass-panel rounded-xl p-8 text-center border border-accent-red/20">
      <div className="w-12 h-12 rounded-full bg-accent-red/10 border border-accent-red/20 flex items-center justify-center mx-auto mb-4">
        <ShieldAlert className="w-6 h-6 text-accent-red" />
      </div>
      <h2 className="text-lg font-bold text-text-primary mb-2">Module Access Restricted</h2>
      <p className="text-xs text-text-secondary leading-relaxed mb-4">
        Your active role (<span className="font-mono text-accent-sky">{user?.role || 'viewer'}</span>) in warehouse{' '}
        <span className="font-mono text-text-primary">{user?.warehouseCode || 'UNSCOPED'}</span> does not hold the
        required permission <span className="font-mono text-accent-yellow">{permission}</span> for{' '}
        <span className="text-text-primary">{title || 'this module'}</span>.
      </p>
      <p className="text-[11px] text-text-secondary/70">
        Contact a Shift Supervisor or System Administrator to request RBAC elevation.
      </p>
    </div>
  );
}

function GuardedPage({
  component: C,
  title,
  permission,
}: {
  component: ComponentType;
  title: string;
  permission: string;
}) {
  const { can } = useAuth();
  if (!can(permission)) {
    return <AccessDenied title={title} permission={permission} />;
  }
  return (
    <RouteErrorBoundary title={title}>
      <Suspense fallback={<PageLoader />}>
        <C />
      </Suspense>
    </RouteErrorBoundary>
  );
}

/**
 * Starts the Hybrid Sync Engine ONLY AFTER:
 *  1. Local IndexedDB seed/schema migration has completed cleanly
 *  2. An authenticated operator session with a validated warehouse scope is active
 *  3. Cloud configuration has passed strict startup validation
 */
function AuthenticatedSyncOrchestrator() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user || !runtimeConfig.cloudEnabled) return;
    let stopSync: (() => void) | null = null;
    let cancelled = false;

    void setActiveWarehouseCode(user.warehouseCode)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          stopSync = startHybridSyncEngine(user.warehouseCode);
        }
      });

    return () => {
      cancelled = true;
      stopSync?.();
    };
  }, [user]);

  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-void">
        <div className="w-8 h-8 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AuthenticatedSyncOrchestrator />
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Control Tower & Instant Wave */}
        <Route index element={<GuardedPage component={Dashboard} title="Control Tower Dashboard" permission="dashboard.view" />} />
        <Route path="dashboard" element={<GuardedPage component={Dashboard} title="Control Tower Dashboard" permission="dashboard.view" />} />
        <Route path="daily" element={<GuardedPage component={DailyManual} title="Daily Instant Fulfillment" permission="daily.execute" />} />
        <Route path="workflow" element={<GuardedPage component={WorkflowSummary} title="Fulfillment Workflow Blueprint" permission="workflow.view" />} />
        <Route path="cloud" element={<GuardedPage component={CloudMonitor} title="Cloud Core & Telemetry" permission="cloud.view" />} />
        <Route path="guardian" element={<GuardedPage component={GuardianDashboard} title="Guardian Ops Center" permission="guardian.view" />} />

        {/* Inbound Operations (Domain 04) */}
        <Route path="dock" element={<GuardedPage component={DockManagement} title="Dock Scheduling & ASN" permission="dock.view" />} />
        <Route path="inbound" element={<GuardedPage component={InboundReceiving} title="Inbound Receiving & GRN" permission="inbound.execute" />} />
        <Route path="qc" element={<GuardedPage component={QCManagement} title="Quality Inspection & Holds" permission="qc.inspect" />} />
        <Route path="putaway" element={<GuardedPage component={PutawayManagement} title="Directed Putaway" permission="putaway.execute" />} />

        {/* Inventory & Location Control (Domains 02, 03, 05, 07) */}
        <Route path="inventory" element={<GuardedPage component={InventoryHub} title="Inventory Hub & Oracle" permission="inventory.view" />} />
        <Route path="serial-tracking" element={<GuardedPage component={SerialTracking} title="Serial & IMEI Traceability" permission="serial.track" />} />
        <Route path="cycle-count" element={<GuardedPage component={CycleCount} title="ABC Cycle Counting" permission="cycle_count.execute" />} />
        <Route path="replenishment" element={<GuardedPage component={Replenishment} title="Min/Max Replenishment" permission="replenishment.execute" />} />
        <Route path="barcode-generator" element={<GuardedPage component={LocationBarcodeGenerator} title="Location & SKU Barcodes" permission="tools.use" />} />
        <Route path="barcode-scanner" element={<GuardedPage component={BarcodeScanner} title="RF / Camera Scanner" permission="tools.use" />} />

        {/* Outbound, Transport & Returns (Domains 06, 08, 09) */}
        <Route path="pick-pack" element={<GuardedPage component={PickPack} title="Pick & Pack Station" permission="outbound.execute" />} />
        <Route path="batch-pick" element={<GuardedPage component={BatchPickCenter} title="Wave & Batch Pick Center" permission="outbound.execute" />} />
        <Route path="shipping" element={<GuardedPage component={Shipping} title="Carrier Dispatch & Manifest" permission="outbound.ship" />} />
        <Route path="posting" element={<GuardedPage component={PostingTracker} title="Proof-of-Dispatch Tracker" permission="outbound.ship" />} />
        <Route path="returns" element={<GuardedPage component={Returns} title="RMA & Returns Disposition" permission="returns.execute" />} />

        {/* Floor Utilities, Integrations & Administration (Domains 10, 11, 12) */}
        <Route path="pdf-sequencer" element={<GuardedPage component={PDFSequencer} title="PDF Label Sequencer" permission="tools.use" />} />
        <Route path="templates" element={<GuardedPage component={Templates} title="SKU Mapping Templates" permission="tools.use" />} />
        <Route path="bulk-convert" element={<GuardedPage component={BulkConverter} title="Bulk Data Converter" permission="tools.use" />} />
        <Route path="auditor" element={<GuardedPage component={Auditor} title="Pack & Weight Auditor" permission="outbound.pack" />} />
        <Route path="sim-manager" element={<GuardedPage component={SIMManager} title="SIM / IMEI TAC Registry" permission="tools.use" />} />
        <Route path="gsheet" element={<GuardedPage component={GSheetHub} title="Daily G-Sheet Tracker" permission="tools.use" />} />
        <Route path="ozon-sheets" element={<GuardedPage component={OzonSheetsHub} title="Ozon Live Sheet Pipeline" permission="tools.use" />} />
        <Route path="integrations" element={<GuardedPage component={IntegrationHub} title="ERP / OMS Integration Hub" permission="integrations.manage" />} />
        <Route path="labor" element={<GuardedPage component={LaborManagement} title="Labor & UPH Management" permission="labor.manage" />} />
        <Route path="analytics" element={<GuardedPage component={Analytics} title="Operational Analytics & KPIs" permission="reports.view" />} />
        <Route path="memory" element={<GuardedPage component={Memory} title="Warehouse Rules & Aliases" permission="memory.manage" />} />
        <Route path="users" element={<GuardedPage component={UserManagement} title="RBAC User & Audit Management" permission="users.manage" />} />
        <Route path="settings" element={<GuardedPage component={Settings} title="System Settings" permission="dashboard.view" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [bootState, setBootState] = useState<'booting' | 'ready' | 'degraded'>('booting');
  const [bootWarning, setBootWarning] = useState<string | null>(null);
  // Surfaces the build-time seeding posture so a production deployment can never
  // silently ship demo credentials.
  const demoSeedPosture = DEMO_SEED_ENABLED ? 'demo-seed enabled' : 'demo-seed disabled';

  useEffect(() => {
    let cancelled = false;

    async function bootstrapStorage() {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('IndexedDB initialization timed out after 8s')), 8_000)
      );

      try {
        const seedResult = await Promise.race([seedDatabase(), timeout]);
        // Move any v2 JSON-blob sync queue into the indexed outbox table before
        // the sync engine starts draining, so offline work is never lost or
        // double-submitted by a second tab.
        await migrateLegacyOutbox().catch(() => undefined);

        if (!cancelled) {
          const notices: string[] = [...runtimeConfig.errors];
          if (runtimeConfig.warnings.length > 0 && runtimeConfig.errors.length === 0) {
            notices.push(runtimeConfig.warnings[0]);
          }
          if (seedResult.demoSeeded) {
            notices.push(
              'DEMO DATASET ACTIVE: seeded operator accounts and sample stock are development data. Set VITE_WMS_ENABLE_DEMO_SEED=false (or build for production) to disable them.',
            );
          } else if (await requiresBootstrap()) {
            notices.push(
              'FIRST RUN: no operator account exists yet. Complete the administrator bootstrap on the sign-in screen before starting floor operations.',
            );
          }
          if (notices.length > 0) setBootWarning(notices.join(' '));
          setBootState('ready');
        }
      } catch (err) {
        // Resilient degraded boot: never hang on a blank spinner if IndexedDB is blocked/corrupted
        if (!cancelled) {
          const message = err instanceof Error ? err.message : '';
          setBootWarning(
            // A missing secure context is a deployment fault, not a database
            // fault: label it as such instead of quoting a TypeError.
            message.startsWith('INSECURE_CONTEXT')
              ? message
              : err instanceof Error
                ? `Local edge database degraded (${message}). Continuing in resilient mode.`
                : 'Local edge database degraded.'
          );
          setBootState('degraded');
        }
      }
    }

    void bootstrapStorage();
    return () => {
      cancelled = true;
    };
  }, []);

  if (bootState === 'booting') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-black gap-3">
        <div className="w-10 h-10 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
        <p className="text-xs text-white/50 font-mono">Initializing YESI-WMS Edge Storage…</p>
        <p className="text-[10px] text-white/30 font-mono uppercase tracking-widest">
          {runtimeConfig.isProduction ? 'production build' : 'development build'} · {demoSeedPosture}
        </p>
      </div>
    );
  }

  return (
    <AuthProvider>
      <RouteErrorBoundary title="Application Error">
        {bootWarning && (
          <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-xs px-4 py-1.5 flex items-center justify-center gap-2 z-50 relative">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{bootWarning}</span>
          </div>
        )}
        <OfflineIndicator />
        <InstallPrompt />
        <CommandPalette />
        <AIAssistant />
        <AppRoutes />
      </RouteErrorBoundary>
    </AuthProvider>
  );
}
