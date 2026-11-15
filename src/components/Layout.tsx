import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar, { useSidebarWidthPx } from './Sidebar';
import TopBar from './TopBar';
import QuickNotes from './QuickNotes';
import { useAppStore } from '@/lib/store';
import { safeMatchMedia } from '@/lib/safeStorage';

export default function Layout() {
  const location = useLocation();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const density = useAppStore((s) => s.density);
  const sidebarWidth = useSidebarWidthPx();
  const compact = density === 'compact';

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    return () => {
      delete document.documentElement.dataset.density;
    };
  }, [density]);

  useEffect(() => {
    document.documentElement.classList.add('h-full');
    document.body.classList.add('h-full', 'overflow-hidden');
    const root = document.getElementById('root');
    if (root) root.classList.add('h-full');
    return () => {
      document.documentElement.classList.remove('h-full');
      document.body.classList.remove('h-full', 'overflow-hidden');
      if (root) root.classList.remove('h-full');
    };
  }, []);

  useEffect(() => {
    const standalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
      safeMatchMedia('(display-mode: standalone)');
    document.body.classList.toggle('pwa-standalone', standalone);
    return () => document.body.classList.remove('pwa-standalone');
  }, []);

  return (
    <div
      className="flex h-[100dvh] w-screen max-w-[100vw] overflow-hidden bg-void"
      style={{
        paddingTop: 'var(--safe-top)',
        paddingLeft: 'var(--safe-left)',
        paddingRight: 'var(--safe-right)',
        // bottom safe area applied on scroll content / install toast
      }}
    >
      <Sidebar mobileOpen={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} />
      <TopBar
        onMenuToggle={() => setMobileSidebarOpen((prev) => !prev)}
        sidebarWidth={sidebarWidth}
      />
      <main
        className="relative flex-1 mt-12 min-h-0 min-w-0 overflow-hidden flex flex-col"
        style={{ maxHeight: 'calc(100dvh - 3rem - var(--safe-top) - var(--safe-bottom))' }}
      >
        <div className="hidden lg:block fixed top-0 bottom-0 pointer-events-none" style={{ width: sidebarWidth }} aria-hidden />
        <div className="flex-1 min-h-0 overflow-auto">
          <style>{`
            @media (min-width: 1024px) {
              main > div.flex-1 { padding-left: ${sidebarWidth}px; }
            }
          `}</style>
          <div
              key={location.pathname}
              className={`h-full min-h-0 ${compact ? 'p-1.5 sm:p-3' : 'p-2 sm:p-4 lg:p-5'} pb-[max(0.5rem,env(safe-area-inset-bottom))]`}
            >
              <Outlet />
            </div>
        </div>
      </main>
      <QuickNotes />
    </div>
  );
}
