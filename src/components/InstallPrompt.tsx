import { useState, useEffect, useCallback } from 'react';
import { Download, X, Share, PlusSquare, Smartphone } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { safeMatchMedia, safeSessionStorage } from '@/lib/safeStorage';

type Platform = 'ios' | 'android' | 'desktop' | 'standalone' | 'tauri';

/** Desktop Tauri shell already is a native install — never show web install UI */
function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'desktop';
  if (isTauriShell()) return 'tauri';
  const nav = window.navigator as Navigator & { standalone?: boolean };
  // Already running as installed PWA / home-screen app
  if (
    nav.standalone === true ||
    safeMatchMedia('(display-mode: standalone)') ||
    safeMatchMedia('(display-mode: minimal-ui)')
  ) {
    return 'standalone';
  }
  const ua = nav.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'yesi_install_dismissed_v2';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [platform] = useState<Platform>(detectPlatform);
  const [showIosGuide, setShowIosGuide] = useState(false);

  useEffect(() => {
    const p = platform;
    if (p === 'standalone' || p === 'tauri') return;

    if (safeSessionStorage.getItem(DISMISS_KEY) === '1') return;

    // Chrome / Edge / Android: native install prompt
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };
    window.addEventListener('beforeinstallprompt', onBip);

    window.addEventListener('appinstalled', () => {
      setShowPrompt(false);
      setDeferredPrompt(null);
      setShowIosGuide(false);
    });

    // iOS Safari never fires beforeinstallprompt — show manual guide after short delay
    let iosTimer: ReturnType<typeof setTimeout> | undefined;
    if (p === 'ios') {
      iosTimer = setTimeout(() => setShowPrompt(true), 1800);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      if (iosTimer) clearTimeout(iosTimer);
    };
  }, [platform]);

  const dismiss = useCallback(() => {
    setShowPrompt(false);
    setShowIosGuide(false);
    safeSessionStorage.setItem(DISMISS_KEY, '1');
  }, []);

  const handleInstallClick = async () => {
    if (platform === 'ios') {
      setShowIosGuide(true);
      return;
    }
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setShowPrompt(false);
    setDeferredPrompt(null);
  };

  if (platform === 'standalone' || platform === 'tauri') return null;

  return (
    <AnimatePresence>
      {showPrompt && !showIosGuide && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          className="fixed z-50 left-1/2 -translate-x-1/2 w-[min(92%,24rem)] glass-panel border border-accent-sky/30 p-4 rounded-xl shadow-2xl flex items-center justify-between gap-3"
          style={{
            bottom: 'max(1.25rem, env(safe-area-inset-bottom, 0px))',
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-accent-sky flex items-center justify-center text-void">
              {platform === 'ios' ? <Smartphone className="w-5 h-5" /> : <Download className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-text-primary truncate">
                {platform === 'ios' ? 'Add to Home Screen' : 'Install YESI Lite'}
              </p>
              <p className="text-xs text-text-secondary leading-snug">
                {platform === 'ios'
                  ? 'Install for offline floor use on iPhone / iPad'
                  : 'Offline-ready warehouse app on this device'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={dismiss}
              className="p-2 text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleInstallClick}
              className="px-3 py-2 bg-accent-sky text-void text-xs font-bold rounded-lg whitespace-nowrap"
            >
              {platform === 'ios' ? 'How to' : 'Install'}
            </button>
          </div>
        </motion.div>
      )}

      {showIosGuide && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 p-4"
          style={{
            paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
            paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))',
          }}
          onClick={dismiss}
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full max-w-md rounded-2xl border border-white/10 bg-void p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-accent-sky" />
                  Install on iPhone / iPad
                </h2>
                <p className="text-xs text-text-secondary mt-1">
                  Safari only · works offline after install
                </p>
              </div>
              <button type="button" onClick={dismiss} className="p-1.5 rounded-md hover:bg-white/5">
                <X className="w-4 h-4 text-text-secondary" />
              </button>
            </div>

            <ol className="space-y-3 text-sm text-white/90">
              <li className="flex gap-3 items-start">
                <span className="w-6 h-6 rounded-full bg-accent-sky/20 text-accent-sky text-xs font-bold flex items-center justify-center shrink-0">
                  1
                </span>
                <span>
                  Tap the <Share className="w-3.5 h-3.5 inline text-accent-sky mx-0.5" />{' '}
                  <strong>Share</strong> button in Safari’s toolbar
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <span className="w-6 h-6 rounded-full bg-accent-sky/20 text-accent-sky text-xs font-bold flex items-center justify-center shrink-0">
                  2
                </span>
                <span>
                  Scroll and tap{' '}
                  <PlusSquare className="w-3.5 h-3.5 inline text-accent-sky mx-0.5" />{' '}
                  <strong>Add to Home Screen</strong>
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <span className="w-6 h-6 rounded-full bg-accent-sky/20 text-accent-sky text-xs font-bold flex items-center justify-center shrink-0">
                  3
                </span>
                <span>
                  Confirm <strong>Add</strong> — open <strong>YESI Lite</strong> from your home screen
                  like a native app
                </span>
              </li>
            </ol>

            <p className="text-[11px] text-text-secondary mt-4 leading-relaxed">
              Must use <strong className="text-white/80">Safari</strong> (not Chrome/Firefox on iOS).
              Host over <strong className="text-white/80">HTTPS</strong> (or localhost). After install,
              the app runs fullscreen offline with local IndexedDB data.
            </p>

            <button
              type="button"
              onClick={dismiss}
              className="mt-4 w-full py-2.5 rounded-xl bg-accent-sky text-void text-sm font-semibold"
            >
              Got it
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
