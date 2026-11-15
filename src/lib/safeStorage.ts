/**
 * Sandboxed / Cross-Origin Iframe Safe Storage & Environment Helpers
 *
 * When running inside cross-origin preview iframes, Safari ITP, Chromium
 * third-party storage restrictions, private browsing, or quota-exhausted
 * warehouse kiosks, accessing or mutating `window.localStorage` /
 * `window.sessionStorage` throws `DOMException('', 'SecurityError')` or
 * `QuotaExceededError`.
 *
 * These wrappers guarantee non-throwing storage reads/writes with seamless
 * in-memory fallback so Zustand, auth envelopes, and floor preferences never
 * crash the React render tree.
 */

const memoryLocal = new Map<string, string>();
const memorySession = new Map<string, string>();

function getNativeStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface SafeStorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createSafeAdapter(kind: 'local' | 'session'): SafeStorageAdapter {
  const mem = kind === 'local' ? memoryLocal : memorySession;

  return {
    getItem(key: string): string | null {
      const native = getNativeStorage(kind);
      if (native) {
        try {
          const val = native.getItem(key);
          if (val !== null) return val;
        } catch {
          // Fall back to in-memory mirror
        }
      }
      return mem.get(key) ?? null;
    },

    setItem(key: string, value: string): void {
      mem.set(key, value);
      const native = getNativeStorage(kind);
      if (native) {
        try {
          native.setItem(key, value);
        } catch {
          // Storage blocked or quota exceeded — in-memory mirror already updated
        }
      }
    },

    removeItem(key: string): void {
      mem.delete(key);
      const native = getNativeStorage(kind);
      if (native) {
        try {
          native.removeItem(key);
        } catch {
          // Ignore storage restriction
        }
      }
    },
  };
}

export const safeLocalStorage: SafeStorageAdapter = createSafeAdapter('local');
export const safeSessionStorage: SafeStorageAdapter = createSafeAdapter('session');

export function safeRandomId(prefix = ''): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return prefix ? `${prefix}${crypto.randomUUID()}` : crypto.randomUUID();
    }
  } catch {
    // Fallback below
  }
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}${rand}` : rand;
}

export function safeMatchMedia(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia(query)?.matches);
  } catch {
    return false;
  }
}
