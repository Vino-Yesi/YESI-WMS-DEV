import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { useAppStore, type DensityMode } from '@/lib/store';
import SyncStatus from './SyncStatus';
import {
  User, Shield, Menu, Bell, X, CheckCircle, AlertTriangle, Info, Rows3, Maximize2, Star, Zap,
} from 'lucide-react';
import { loadOperatorStats, subscribeOperatorStats } from '@/lib/operatorStatsStore';
import type { OperatorStats } from '@/lib/neuralOps';

interface TopBarProps {
  onMenuToggle?: () => void;
  sidebarWidth?: number;
}

const TYPE_ICONS = {
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertTriangle,
  info: Info,
};

const TYPE_COLORS = {
  success: 'text-accent-green',
  warning: 'text-accent-yellow',
  error: 'text-accent-red',
  info: 'text-accent-sky',
};

function LiveClock() {
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="text-[11px] text-text-secondary font-mono hidden sm:block tabular-nums">
      {currentTime.toLocaleTimeString()}
    </div>
  );
}

export default function TopBar({ onMenuToggle, sidebarWidth = 220 }: TopBarProps) {
  const { user, isAdmin } = useAuth();
  const notifications = useAppStore((s) => s.notifications);
  const markRead = useAppStore((s) => s.markRead);
  const clearNotifications = useAppStore((s) => s.clearNotifications);
  const density = useAppStore((s) => s.density);
  const setDensity = useAppStore((s) => s.setDensity);
  const unread = notifications.filter((n) => !n.read).length;

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [showNotifs, setShowNotifs] = useState(false);
  const [stats, setStats] = useState<OperatorStats | null>(null);
  const [showStats, setShowStats] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  const username = user?.username || user?.displayName || '';

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    loadOperatorStats(username).then((s) => {
      if (!cancelled) setStats(s);
    });
    const unsub = subscribeOperatorStats(username, (s) => setStats(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, [username]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowNotifs(false);
      }
      if (statsRef.current && !statsRef.current.contains(e.target as Node)) {
        setShowStats(false);
      }
    };
    if (showNotifs || showStats) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showNotifs, showStats]);

  const openNotifs = () => {
    setShowNotifs((v) => !v);
    notifications.filter((n) => !n.read).forEach((n) => markRead(n.id));
  };

  const toggleDensity = () => {
    const next: DensityMode = density === 'compact' ? 'comfortable' : 'compact';
    setDensity(next);
  };

  const xpIntoLevel = stats ? stats.xp % 1000 : 0;
  const xpPct = Math.min(100, Math.round((xpIntoLevel / 1000) * 100));

  return (
    <header
      className="fixed top-0 right-0 h-12 glass-panel border-b border-white/[0.06] flex items-center justify-between px-3 lg:px-4 z-40 transition-[left] duration-200"
      style={{ left: 0 }}
    >
      <style>{`
        @media (min-width: 1024px) {
          header.glass-panel { left: ${sidebarWidth}px !important; }
        }
      `}</style>

      <div className="flex items-center gap-2">
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-1.5 -ml-1 text-text-secondary hover:text-text-primary rounded-md hover:bg-white/5 transition-colors"
          aria-label="Toggle menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <SyncStatus isOnline={isOnline} />
      </div>

      <div className="flex items-center gap-2 lg:gap-3">
        <LiveClock />

        <button
          onClick={toggleDensity}
          className="p-1.5 text-text-secondary hover:text-text-primary rounded-md hover:bg-white/5 transition-colors"
          title={density === 'compact' ? 'Comfortable density' : 'Compact density'}
        >
          {density === 'compact' ? <Maximize2 className="w-3.5 h-3.5" /> : <Rows3 className="w-3.5 h-3.5" />}
        </button>

        {/* Operator XP badge */}
        {stats && (
          <div className="relative" ref={statsRef}>
            <button
              type="button"
              onClick={() => setShowStats((v) => !v)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
              title="Operator progression"
            >
              <Zap className="w-3 h-3 text-amber-400" />
              <span className="text-[10px] font-semibold text-white tabular-nums">Lv {stats.level}</span>
              <div className="hidden sm:block w-12 h-1 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-amber-400/80 rounded-full" style={{ width: `${xpPct}%` }} />
              </div>
              <span className="text-[9px] text-text-secondary tabular-nums hidden md:inline">{stats.xp} XP</span>
            </button>
            {showStats && (
              <div className="absolute right-0 top-full mt-1.5 w-64 rounded-lg border border-white/10 bg-void/95 shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Star className="w-3.5 h-3.5 text-amber-400" /> Operator stats
                  </span>
                  <button type="button" onClick={() => setShowStats(false)} className="p-0.5 hover:bg-white/5 rounded">
                    <X className="w-3 h-3 text-text-secondary" />
                  </button>
                </div>
                <div className="p-3 space-y-2 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Level</span>
                    <span className="text-white font-semibold tabular-nums">{stats.level}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">XP</span>
                    <span className="text-white tabular-nums">{stats.xp} · {xpIntoLevel}/1000 to next</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Accuracy</span>
                    <span className="text-emerald-400 tabular-nums">{stats.accuracy}%</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div className="rounded border border-white/10 p-1.5 text-center">
                      <div className="text-text-secondary text-[9px]">Picks</div>
                      <div className="text-white font-semibold tabular-nums">{stats.picks}</div>
                    </div>
                    <div className="rounded border border-white/10 p-1.5 text-center">
                      <div className="text-text-secondary text-[9px]">Audits</div>
                      <div className="text-white font-semibold tabular-nums">{stats.audits}</div>
                    </div>
                    <div className="rounded border border-white/10 p-1.5 text-center">
                      <div className="text-text-secondary text-[9px]">Scans</div>
                      <div className="text-white font-semibold tabular-nums">{stats.scans}</div>
                    </div>
                  </div>
                  {stats.badges.length > 0 && (
                    <div className="pt-1 border-t border-white/10">
                      <div className="text-text-secondary text-[9px] mb-1">Badges</div>
                      <div className="flex flex-wrap gap-1">
                        {stats.badges.map((b) => (
                          <span key={b} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/10">
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-[9px] text-text-secondary">
                    Streak {stats.streak} · XP from assemble / audit / scan
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="relative" ref={panelRef}>
          <button
            onClick={openNotifs}
            className="relative p-1.5 text-text-secondary hover:text-text-primary rounded-md hover:bg-white/5 transition-colors"
            aria-label="Notifications"
          >
            <Bell className="w-4 h-4" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-accent-red text-[9px] font-bold text-white flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {showNotifs && (
            <div className="absolute right-0 top-full mt-1.5 w-72 rounded-lg border border-white/10 bg-void/95 shadow-xl z-50 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="text-xs font-semibold text-white">Alerts</span>
                <div className="flex items-center gap-2">
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={clearNotifications}
                      className="text-[10px] text-text-secondary hover:text-text-primary"
                    >
                      Clear
                    </button>
                  )}
                  <button type="button" onClick={() => setShowNotifs(false)} className="p-0.5 hover:bg-white/5 rounded">
                    <X className="w-3 h-3 text-text-secondary" />
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto max-h-64">
                {notifications.length === 0 ? (
                  <p className="p-3 text-xs text-text-secondary text-center">No alerts</p>
                ) : (
                  notifications.map((n) => {
                    const Icon = TYPE_ICONS[n.type];
                    return (
                      <div
                        key={n.id}
                        className={`px-3 py-2 border-b border-white/5 hover:bg-white/5 cursor-pointer ${!n.read ? 'bg-white/[0.02]' : ''}`}
                        onClick={() => markRead(n.id)}
                      >
                        <div className="flex items-start gap-2">
                          <Icon className={`w-3 h-3 mt-0.5 shrink-0 ${TYPE_COLORS[n.type]}`} />
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold text-text-primary">{n.title}</p>
                            <p className="text-[10px] text-text-secondary mt-0.5 line-clamp-2">{n.message}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-full bg-accent-sky/20 flex items-center justify-center">
            {isAdmin ? (
              <Shield className="w-3 h-3 text-accent-sky" />
            ) : (
              <User className="w-3 h-3 text-accent-sky" />
            )}
          </div>
          <div className="hidden sm:flex flex-col leading-none">
            <span className="text-[11px] font-semibold text-text-primary">
              {user?.displayName || 'Unknown'}
            </span>
            <span className="text-[9px] text-text-secondary uppercase tracking-wider mt-0.5">
              {isAdmin ? 'Admin' : 'Operator'}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
