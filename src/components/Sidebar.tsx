/* eslint-disable react-refresh/only-export-components */
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/lib/store';
import {
  LayoutDashboard,
  Package,
  PackageOpen,
  RotateCcw,
  ScanBarcode,
  Scale,
  RefreshCw,
  Settings,
  Users,
  LogOut,
  Hexagon,
  BarChart3,
  ClipboardCheck,
  Zap,
  ShieldCheck,
  FileText,
  Brain,
  Smartphone,
  Shield,
  X,
  Camera,
  Barcode,
  Truck,
  Plug,
  ArrowDownToLine,
  Fingerprint,
  Layers,
  UsersRound,
  Bot,
  Sheet,
  PanelLeftClose,
  PanelLeft,
  Link2,
  Database,
  CalendarClock,
  GitBranch,
  ArrowRightLeft,
} from 'lucide-react';

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

type NavItem = {
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  short: string;
  aiTrigger?: boolean;
  adminOnly?: boolean;
  supervisorOnly?: boolean;
};

// 01. Control Tower & Daily Fulfillment
const controlItems: NavItem[] = [
  { icon: LayoutDashboard, label: 'Control Tower', path: '/', short: 'KPI' },
  { icon: Zap, label: 'Daily Manual', path: '/daily', short: 'Wave' },
  { icon: GitBranch, label: 'Workflow Map', path: '/workflow', short: 'Flow' },
  { icon: Shield, label: 'Guardian Ops', path: '/guardian', short: 'Grd' },
  { icon: Database, label: 'Cloud & DB', path: '/cloud', short: 'SQL' },
];

// 04. Inbound Domain (ASN -> Dock -> Receive/GRN -> QC -> Putaway)
const inboundItems: NavItem[] = [
  { icon: CalendarClock, label: 'Dock & ASN', path: '/dock', short: 'Dock' },
  { icon: Package, label: 'Inbound GRN', path: '/inbound', short: 'GRN' },
  { icon: ShieldCheck, label: 'QC Inspection', path: '/qc', short: 'QC' },
  { icon: ArrowDownToLine, label: 'Putaway', path: '/putaway', short: 'Put' },
];

// 02/03/05/07. Inventory, Locations, Serials & Replenishment
const inventoryItems: NavItem[] = [
  { icon: ClipboardCheck, label: 'Inventory Hub', path: '/inventory', short: 'Inv' },
  { icon: Fingerprint, label: 'Serial / IMEI', path: '/serial-tracking', short: 'IMEI' },
  { icon: ArrowRightLeft, label: 'Replenishment', path: '/replenishment', short: 'Rpl' },
  { icon: Scale, label: 'Cycle Count', path: '/cycle-count', short: 'Cnt' },
  { icon: ScanBarcode, label: 'RF Scanner', path: '/barcode-scanner', short: 'Scan' },
  { icon: Barcode, label: 'Bin Barcodes', path: '/barcode-generator', short: 'Bins' },
];

// 06/08/09. Outbound, Dispatch & Returns
const outboundItems: NavItem[] = [
  { icon: PackageOpen, label: 'Pick & Pack', path: '/pick-pack', short: 'Pick' },
  { icon: Layers, label: 'Wave / Batch', path: '/batch-pick', short: 'Batch' },
  { icon: Truck, label: 'Shipping', path: '/shipping', short: 'Ship' },
  { icon: Camera, label: 'POD Tracker', path: '/posting', short: 'POD' },
  { icon: RotateCcw, label: 'Returns / RMA', path: '/returns', short: 'RMA' },
];

// 10. Marketplace, Label & Floor Tools
const toolItems: NavItem[] = [
  { icon: ScanBarcode, label: 'PDF Sequencer', path: '/pdf-sequencer', short: 'PDF' },
  { icon: Scale, label: 'Pack Auditor', path: '/auditor', short: 'Aud' },
  { icon: Smartphone, label: 'SIM / TAC DB', path: '/sim-manager', short: 'TAC' },
  { icon: Sheet, label: 'Ozon Sync', path: '/ozon-sheets', short: 'Ozon' },
  { icon: Link2, label: 'G-Sheets', path: '/gsheet', short: 'GSht' },
  { icon: FileText, label: 'Templates', path: '/templates', short: 'Tpl' },
  { icon: RefreshCw, label: 'Bulk Convert', path: '/bulk-convert', short: 'Bulk' },
];

// 11/12. Integrations, Labor, Analytics & RBAC Admin
const adminItems: NavItem[] = [
  { icon: BarChart3, label: 'Analytics', path: '/analytics', short: 'BI' },
  { icon: UsersRound, label: 'Labor & UPH', path: '/labor', short: 'UPH', supervisorOnly: true },
  { icon: Plug, label: 'Integrations', path: '/integrations', short: 'API', supervisorOnly: true },
  { icon: Brain, label: 'Rules & Memory', path: '/memory', short: 'Mem', supervisorOnly: true },
  { icon: Users, label: 'Users & RBAC', path: '/users', short: 'RBAC', adminOnly: true },
];

export default function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, isSupervisor, canAccessModule, logout } = useAuth();
  const density = useAppStore((s) => s.density);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleSidebarCollapsed);
  const setAiOpen = useAppStore((s) => s.setAiAssistantOpen);

  const compact = density === 'compact';
  const itemPad = compact ? 'px-2 py-1.5' : 'px-3 py-2';
  const gap = compact ? 'gap-2' : 'gap-2.5';
  const sectionGap = compact ? 'space-y-0.5' : 'space-y-1';
  const iconSize = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const textSize = compact ? 'text-xs' : 'text-[13px]';
  const sectionLabel = compact ? 'text-[9px] px-2 mb-1' : 'text-[10px] px-3 mb-1.5';

  const handleNav = (path: string, aiTrigger?: boolean) => {
    if (aiTrigger) {
      setAiOpen(true);
      onClose?.();
      return;
    }
    navigate(path);
    onClose?.();
  };

  const sidebarBaseStyle = {
    background: '#0c0c0e',
  };

  const renderNavItems = (items: NavItem[]) =>
    items
      .filter((item) => {
        if (item.adminOnly && !isAdmin) return false;
        if (item.supervisorOnly && !isSupervisor) return false;
        if (!item.aiTrigger && !canAccessModule(item.path)) return false;
        return true;
      })
      .map((item) => {
        const isActive =
          !item.aiTrigger &&
          (location.pathname === item.path ||
            (item.path === '/' && location.pathname === '/dashboard'));
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => handleNav(item.path, item.aiTrigger)}
            title={collapsed ? item.label : undefined}
            className={`relative w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} transition-all duration-150 group ${
              collapsed ? 'justify-center' : ''
            }`}
            style={
              isActive
                ? {
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.22)',
                  }
                : { border: '1px solid transparent' }
            }
          >
            {isActive && !collapsed && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-accent-sky rounded-r-full" />
            )}
            <item.icon
              className={`${iconSize} shrink-0 ${
                isActive ? 'text-accent-sky' : 'text-white/50 group-hover:text-white'
              }`}
            />
            {!collapsed && (
              <span
                className={`font-medium truncate ${
                  isActive ? 'text-white' : 'text-text-secondary group-hover:text-white'
                }`}
              >
                {compact ? item.short : item.label}
              </span>
            )}
          </button>
        );
      });

  const desktopWidth = collapsed ? 'w-[56px]' : compact ? 'w-[176px]' : 'w-[224px]';

  const asideContent = (isMobile: boolean) => (
    <>
      <div
        className={`flex items-center ${
          collapsed && !isMobile ? 'justify-center px-1' : 'gap-2 px-3'
        } ${compact ? 'py-3' : 'py-3.5'} border-b border-white/[0.06]`}
      >
        <div
          className={`${
            compact ? 'w-7 h-7' : 'w-8 h-8'
          } rounded-md flex items-center justify-center shrink-0 bg-sky-500`}
        >
          <Hexagon className={compact ? 'w-3.5 h-3.5 text-white' : 'w-4 h-4 text-white'} />
        </div>
        {(!collapsed || isMobile) && (
          <div className="min-w-0 flex-1">
            <h1 className={`${compact ? 'text-[11px]' : 'text-xs'} font-bold text-white tracking-tight truncate`}>
              YESI WMS
            </h1>
            <p className="text-[9px] text-sky-400/75 uppercase tracking-wider truncate">Enterprise v2</p>
          </div>
        )}
        {!isMobile && (
          <button
            type="button"
            onClick={toggleCollapsed}
            className="p-1 rounded text-white/40 hover:text-white hover:bg-white/5 transition-colors shrink-0"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
        )}
        {isMobile && (
          <button type="button" onClick={onClose} className="p-1 rounded text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav className={`flex-1 overflow-y-auto ${compact ? 'px-1.5 py-2' : 'px-2 py-2.5'} ${sectionGap}`}>
        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium`}>Control</div>
        )}
        <div className={sectionGap}>{renderNavItems(controlItems)}</div>

        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>04 · Inbound</div>
        )}
        <div className={sectionGap}>{renderNavItems(inboundItems)}</div>

        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>05 · Inventory</div>
        )}
        <div className={sectionGap}>{renderNavItems(inventoryItems)}</div>

        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>06 · Outbound</div>
        )}
        <div className={sectionGap}>{renderNavItems(outboundItems)}</div>

        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>10 · Floor Tools</div>
        )}
        <div className={sectionGap}>{renderNavItems(toolItems)}</div>

        {(!collapsed || isMobile) && (
          <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>12 · Governance</div>
        )}
        <div className={sectionGap}>{renderNavItems(adminItems)}</div>
      </nav>

      {/* Footer */}
      <div className={`border-t border-white/[0.06] ${compact ? 'p-1.5' : 'p-2'} ${sectionGap}`}>
        <button
          type="button"
          onClick={() => handleNav('/ai', true)}
          className={`w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} text-sky-400/90 hover:text-sky-300 hover:bg-sky-500/10 transition-colors ${
            collapsed && !isMobile ? 'justify-center' : ''
          }`}
          title="Neural WMS Assistant"
        >
          <Bot className={`${iconSize} shrink-0`} />
          {(!collapsed || isMobile) && <span className="font-medium">AI Copilot</span>}
        </button>
        <button
          type="button"
          onClick={() => handleNav('/settings')}
          className={`w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} text-text-secondary hover:text-white hover:bg-white/5 transition-colors ${
            collapsed && !isMobile ? 'justify-center' : ''
          }`}
          title="Settings"
        >
          <Settings className={`${iconSize} shrink-0`} />
          {(!collapsed || isMobile) && <span className="font-medium">Settings</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            logout();
            onClose?.();
          }}
          className={`w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} text-accent-red/80 hover:text-accent-red hover:bg-accent-red/10 transition-colors ${
            collapsed && !isMobile ? 'justify-center' : ''
          }`}
          title="Sign out"
        >
          <LogOut className={`${iconSize} shrink-0`} />
          {(!collapsed || isMobile) && <span className="font-medium">Sign out</span>}
        </button>
      </div>
    </>
  );

  return (
    <>
      <aside
        className={`hidden lg:flex fixed left-0 top-0 h-full ${desktopWidth} border-r border-white/[0.06] flex-col z-50 transition-[width] duration-200`}
        style={sidebarBaseStyle}
        data-sidebar-width={collapsed ? 56 : compact ? 176 : 224}
      >
        {asideContent(false)}
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-40 lg:hidden"
              onClick={onClose}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              className="fixed left-0 top-0 h-full w-[240px] border-r border-white/[0.06] flex flex-col z-50 lg:hidden"
              style={sidebarBaseStyle}
            >
              {asideContent(true)}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export function useSidebarWidthPx(): number {
  const density = useAppStore((s) => s.density);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  if (collapsed) return 56;
  return density === 'compact' ? 176 : 224;
}
