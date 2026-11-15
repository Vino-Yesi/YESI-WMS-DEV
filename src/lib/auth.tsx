import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  db,
  logAction,
  bootstrapInitialAdmin,
  requiresBootstrap,
  rotateLocalPassword,
  validatePasswordStrength,
  DEFAULT_TENANT_CODE,
  type User,
} from './db';
import {
  hashPasswordLocal,
  verifyPasswordLocal,
  hasPermission,
  canAccessRoute,
  canAccessWarehouse,
  encryptSessionEnvelope,
  decryptSessionEnvelope,
  type WmsRole,
} from './security';
import {
  supabase,
  WMS_TENANT_CODE,
  WMS_DEFAULT_WAREHOUSE,
  isSupabaseConfigured,
  setActiveServerSessionToken,
  getActiveServerSessionToken,
} from './supabase';
import { safeLocalStorage, safeSessionStorage, safeRandomId } from './safeStorage';

export interface AuthUser {
  id: number | string;
  username: string;
  role: WmsRole;
  displayName: string;
  tenantCode: string;
  warehouseCode: string;
  warehouseName?: string;
  allowedWarehouses: string[];
  authMode: 'supabase-pgcrypto' | 'edge-pbkdf2';
  /**
   * Server-set flag (migration 008). A legacy/demo credential or a freshly
   * bootstrapped admin must rotate the password before floor operations run.
   */
  mustChangePassword?: boolean;
  passwordChangedAt?: string | null;
}

/** Result of `wms_get_bootstrap_status` for the first-run screen. */
export interface BootstrapStatus {
  bootstrap_required: boolean;
  tenant_code: string | null;
  active_users: number;
  users_requiring_rotation: number;
  bootstrap_completed_at: string | null;
}

export type RotatePasswordResult =
  | { ok: true; message: string }
  | { ok: false; code: string; message: string };

interface EncryptedSessionPayload {
  user: AuthUser;
  serverSessionToken: string | null;
  expiresAt: string;
  issuedAt: string;
}

interface LockoutRecord {
  count: number;
  lockedUntil: number;
}

export interface LoginOutcome {
  ok: boolean;
  code?:
    | 'INVALID_CREDENTIALS'
    | 'ACCOUNT_LOCKED'
    | 'WAREHOUSE_FORBIDDEN'
    | 'TENANT_REQUIRED'
    | 'PASSWORD_CHANGE_REQUIRED'
    | 'BOOTSTRAP_REQUIRED';
  message?: string;
  lockedUntil?: string;
  remainingAttempts?: number;
  /** Set when the credential is valid but must be rotated before use. */
  mustChangePassword?: boolean;
  /** Valid session data, withheld from the app until rotation completes. */
  pendingUser?: AuthUser;
  pendingSessionToken?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username: string, password: string, warehouseCode?: string) => Promise<boolean>;
  loginDetailed: (username: string, password: string, warehouseCode?: string) => Promise<LoginOutcome>;
  logout: () => void;
  switchWarehouse: (warehouseCode: string) => Promise<{ ok: boolean; error?: string }>;
  /** True when the signed-in operator must rotate their credential. */
  mustChangePassword: boolean;
  /** First-run bootstrap probe (cloud `wms_get_bootstrap_status`, local fallback). */
  getBootstrapStatus: () => Promise<BootstrapStatus>;
  /** Creates the very first administrator; refuses once any account exists. */
  bootstrapFirstAdmin: (input: {
    username: string;
    password: string;
    displayName?: string;
    email?: string;
    warehouseCode?: string;
  }) => Promise<LoginOutcome>;
  /** Rotates the signed-in (or pending) operator's credential. */
  rotatePassword: (input: {
    currentPassword: string;
    newPassword: string;
    username?: string;
  }) => Promise<RotatePasswordResult>;
  isAdmin: boolean;
  isSupervisor: boolean;
  can: (permission: string) => boolean;
  canAccessModule: (path: string) => boolean;
  loading: boolean;
  lastAuthError: string | null;
  updateUser: (updates: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => false,
  loginDetailed: async () => ({ ok: false }),
  logout: () => {},
  switchWarehouse: async () => ({ ok: false }),
  mustChangePassword: false,
  getBootstrapStatus: async () => ({
    bootstrap_required: false,
    tenant_code: null,
    active_users: 0,
    users_requiring_rotation: 0,
    bootstrap_completed_at: null,
  }),
  bootstrapFirstAdmin: async () => ({ ok: false, code: 'BOOTSTRAP_REQUIRED', message: 'Auth provider not mounted' }),
  rotatePassword: async () => ({ ok: false, code: 'AUTH_REQUIRED', message: 'Not authenticated' }),
  isAdmin: false,
  isSupervisor: false,
  can: () => false,
  canAccessModule: () => false,
  loading: true,
  lastAuthError: null,
  updateUser: () => {},
});

const SESSION_TIMEOUT_MINUTES = 45;
const MAX_FAILED_ATTEMPTS = 5;
const SESSION_STORAGE_KEY = 'yesi_wms_session_enc_v2';
const LEGACY_LOCALSTORAGE_KEY = 'vortex_session';
const LOCKOUT_PREF_PREFIX = 'auth_lockout:';

function getDeviceId(): string {
  let id = safeSessionStorage.getItem('yesi_device_id');
  if (!id) {
    id = `dev-${safeRandomId().slice(0, 12)}`;
    safeSessionStorage.setItem('yesi_device_id', id);
  }
  return id;
}

async function getLocalLockout(username: string): Promise<LockoutRecord> {
  try {
    const key = `${LOCKOUT_PREF_PREFIX}${username.toLowerCase()}`;
    const row = await db.preferences.where('key').equals(key).first();
    if (!row?.value) return { count: 0, lockedUntil: 0 };
    const parsed = JSON.parse(row.value) as LockoutRecord;
    return {
      count: Number(parsed.count || 0),
      lockedUntil: Number(parsed.lockedUntil || 0),
    };
  } catch {
    return { count: 0, lockedUntil: 0 };
  }
}

async function saveLocalLockout(username: string, record: LockoutRecord): Promise<void> {
  try {
    const key = `${LOCKOUT_PREF_PREFIX}${username.toLowerCase()}`;
    const existing = await db.preferences.where('key').equals(key).first();
    const value = JSON.stringify(record);
    if (existing?.id != null) {
      await db.preferences.update(existing.id, { value, createdAt: new Date().toISOString() });
    } else {
      await db.preferences.add({ key, value, createdAt: new Date().toISOString() });
    }
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAuthError, setLastAuthError] = useState<string | null>(null);
  /**
   * A credential that authenticated successfully but is flagged
   * `must_change_password`. It is held here instead of being promoted to a live
   * session, so the operator can rotate it before touching floor data.
   */
  const [pendingRotation, setPendingRotation] = useState<{ user: AuthUser; sessionToken: string | null } | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const userRef = useRef<AuthUser | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const clearClientSession = useCallback(() => {
    safeSessionStorage.removeItem(SESSION_STORAGE_KEY);
    safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
    setActiveServerSessionToken(null);
    setPendingRotation(null);
    setUser(null);
  }, []);

  const persistEncryptedSession = useCallback(async (sessionUser: AuthUser, serverToken: string | null) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TIMEOUT_MINUTES * 60 * 1000);
    const payload: EncryptedSessionPayload = {
      user: sessionUser,
      serverSessionToken: serverToken,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    setActiveServerSessionToken(serverToken);
    try {
      safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
      const encrypted = await encryptSessionEnvelope(payload);
      safeSessionStorage.setItem(SESSION_STORAGE_KEY, encrypted);
    } catch {
      // Keep in-memory session even if storage quota/crypto fails
    }
    setUser(sessionUser);
    lastActivityRef.current = Date.now();
  }, []);

  // Restore & strictly validate encrypted session on startup
  useEffect(() => {
    let cancelled = false;
    async function restoreSession() {
      try {
        // Purge any legacy plaintext localStorage session immediately
        safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);

        const raw = safeSessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
          if (!cancelled) setLoading(false);
          return;
        }

        const decoded = await decryptSessionEnvelope<EncryptedSessionPayload>(raw);
        if (!decoded || !decoded.user || !decoded.expiresAt || new Date(decoded.expiresAt) <= new Date()) {
          clearClientSession();
          if (!cancelled) setLoading(false);
          return;
        }

        // Enforce tenant match
        if (decoded.user.tenantCode !== WMS_TENANT_CODE) {
          clearClientSession();
          if (!cancelled) setLoading(false);
          return;
        }

        // Re-verify server-side session token if online & issued by Supabase
        if (
          decoded.serverSessionToken &&
          isSupabaseConfigured &&
          (typeof navigator === 'undefined' || navigator.onLine)
        ) {
          try {
            const { data, error } = await supabase.rpc('wms_validate_session', {
              p_session_token: decoded.serverSessionToken,
              p_tenant_code: decoded.user.tenantCode,
              p_warehouse_code: decoded.user.warehouseCode,
            });
            if (error || !data?.valid) {
              clearClientSession();
              if (!cancelled) setLoading(false);
              return;
            }
          } catch {
            // Network transiently unreachable: allow valid unexpired AES-GCM session to continue offline
          }
        }

        if (!cancelled) {
          setActiveServerSessionToken(decoded.serverSessionToken);
          setUser(decoded.user);
          setLoading(false);
        }
      } catch {
        clearClientSession();
        if (!cancelled) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [clearClientSession]);

  const logout = useCallback(() => {
    const current = userRef.current;
    const token = getActiveServerSessionToken();
    if (current) {
      void logAction('LOGOUT', `User ${current.username} logged out from ${current.warehouseCode}`, current.displayName);
    }
    if (token && isSupabaseConfigured) {
      void Promise.resolve(supabase.rpc('wms_revoke_session', { p_session_token: token })).catch(() => {});
    }
    clearClientSession();
  }, [clearClientSession]);

  // Rolling inactivity session timeout (tracked via ref to ensure zero React re-renders on floor pointer/scroll activity)
  useEffect(() => {
    if (!user) return;
    lastActivityRef.current = Date.now();

    const checkTimeout = () => {
      const inactive = Date.now() - lastActivityRef.current;
      if (inactive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
        void logAction('SESSION_EXPIRED', `Inactivity timeout for ${user.username}`, user.displayName);
        logout();
      }
    };

    const interval = setInterval(checkTimeout, 30_000);
    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };
    activityEvents.forEach((e) => window.addEventListener(e, updateActivity, { passive: true }));

    return () => {
      clearInterval(interval);
      activityEvents.forEach((e) => window.removeEventListener(e, updateActivity));
    };
  }, [user, logout]);

  const loginDetailed = useCallback(
    async (username: string, password: string, requestedWarehouse?: string): Promise<LoginOutcome> => {
      const cleanUser = username.trim();
      const targetWh = (requestedWarehouse || WMS_DEFAULT_WAREHOUSE).trim().toUpperCase();
      setLastAuthError(null);

      if (!cleanUser || !password) {
        const msg = 'Username and password are required.';
        setLastAuthError(msg);
        return { ok: false, code: 'INVALID_CREDENTIALS', message: msg };
      }

      // Check durable local lockout state first (prevents brute-force across reloads)
      const localLock = await getLocalLockout(cleanUser);
      if (localLock.lockedUntil > Date.now()) {
        const minsLeft = Math.max(1, Math.ceil((localLock.lockedUntil - Date.now()) / 60_000));
        const msg = `Account temporarily locked due to failed login attempts. Try again in ${minsLeft} min.`;
        setLastAuthError(msg);
        await logAction('LOGIN_LOCKED_BLOCKED', `Blocked login attempt for locked account ${cleanUser}`, cleanUser);
        return {
          ok: false,
          code: 'ACCOUNT_LOCKED',
          message: msg,
          lockedUntil: new Date(localLock.lockedUntil).toISOString(),
        };
      }

      // 1. Primary Cloud Authentication via Supabase PostgreSQL v2 RPC (pgcrypto + server lockout + signed token)
      if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        try {
          const { data, error } = await supabase.rpc('wms_authenticate_user_v2', {
            p_username: cleanUser,
            p_password: password,
            p_tenant_code: WMS_TENANT_CODE,
            p_warehouse_code: targetWh,
            p_device_id: getDeviceId(),
            p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : 'YESI-WMS',
          });

          if (!error && data) {
            if (!data.authenticated) {
              if (data.code === 'ACCOUNT_LOCKED') {
                const lockUntilMs = data.locked_until
                  ? new Date(data.locked_until).getTime()
                  : Date.now() + 5 * 60_000;
                await saveLocalLockout(cleanUser, { count: MAX_FAILED_ATTEMPTS, lockedUntil: lockUntilMs });
              }
              const msg = data.error || 'Invalid credentials.';
              setLastAuthError(msg);
              return {
                ok: false,
                code: data.code || 'INVALID_CREDENTIALS',
                message: msg,
                remainingAttempts: data.remaining_attempts,
                lockedUntil: data.locked_until,
              };
            }

            if (data.authenticated && data.user) {
              const u = data.user;
              const mappedRole: WmsRole = (
                ['admin', 'supervisor', 'operator', 'auditor', 'viewer'].includes(u.role)
                  ? u.role
                  : 'operator'
              ) as WmsRole;
              const allowedWarehouses: string[] = Array.isArray(u.allowedWarehouses) && u.allowedWarehouses.length > 0
                ? u.allowedWarehouses
                : [u.warehouseCode || targetWh];

              // Mirror PBKDF2-SHA256 credential into local IndexedDB when available (never abort cloud login if IndexedDB is blocked in cross-origin iframe)
              let localId: number | string = u.id;
              try {
                const localHash = await hashPasswordLocal(password);
                const allLocal = await db.users.toArray();
                const localMatch = allLocal.find((x) => x.username.toLowerCase() === cleanUser.toLowerCase());
                const persistedRole: 'admin' | 'supervisor' | 'operator' =
                  mappedRole === 'admin' || mappedRole === 'supervisor' ? mappedRole : 'operator';
                if (localMatch?.id != null) {
                  await db.users.update(localMatch.id, {
                    password: localHash,
                    role: persistedRole,
                    displayName: u.displayName || cleanUser,
                  });
                  localId = localMatch.id;
                } else {
                  localId = await db.users.add({
                    username: u.username || cleanUser,
                    password: localHash,
                    role: persistedRole,
                    displayName: u.displayName || cleanUser,
                    createdAt: new Date().toISOString(),
                    skillLevel: Number(u.skillLevel || 3),
                    currentZone: u.currentZone || 'PHONE-A',
                  });
                }
              } catch {
                // IndexedDB blocked/unavailable in sandboxed iframe — proceed with verified cloud session
              }

              const mustRotate = Boolean(data.must_change_password ?? u.mustChangePassword);
              const sessionUser: AuthUser = {
                id: localId,
                username: u.username || cleanUser,
                role: mappedRole,
                displayName: u.displayName || cleanUser,
                tenantCode: u.tenantCode || WMS_TENANT_CODE,
                warehouseCode: u.warehouseCode || targetWh,
                warehouseName: u.warehouseName || 'Fulfillment Center',
                allowedWarehouses,
                authMode: 'supabase-pgcrypto',
                mustChangePassword: mustRotate,
                passwordChangedAt: u.passwordChangedAt ?? null,
              };

              await saveLocalLockout(cleanUser, { count: 0, lockedUntil: 0 });

              // A flagged credential authenticates but is NOT promoted to a live
              // session: the operator must rotate it first. The verified session
              // token is retained so the rotation RPC can authorize itself.
              if (mustRotate) {
                setPendingRotation({ user: sessionUser, sessionToken: data.session_token || null });
                setActiveServerSessionToken(data.session_token || null);
                await logAction(
                  'PASSWORD_ROTATION_REQUIRED',
                  `Server flagged ${sessionUser.username} for mandatory credential rotation`,
                  sessionUser.displayName,
                );
                return {
                  ok: false,
                  code: 'PASSWORD_CHANGE_REQUIRED',
                  message:
                    'This credential is flagged for mandatory rotation (legacy or first-run account). Set a new password to continue.',
                  mustChangePassword: true,
                  pendingUser: sessionUser,
                  pendingSessionToken: data.session_token || null,
                };
              }

              await persistEncryptedSession(sessionUser, data.session_token || null);
              return { ok: true };
            }
          }
        } catch {
          // Network unreachable -> fall back to local PBKDF2-SHA256 edge verification
        }
      }

      // 2. Offline Edge Authentication via Web Crypto PBKDF2-SHA256
      let allUsers: User[] = [];
      try {
        allUsers = await db.users.toArray();
      } catch {
        // IndexedDB blocked/unavailable
      }
      const found = allUsers.find((u) => u.username.toLowerCase() === cleanUser.toLowerCase());

      if (found && found.id != null) {
        const valid = await verifyPasswordLocal(password, found.password);
        if (valid) {
          // Honour the account's own scope; never invent another site's code.
          const allowedWarehouses =
            found.role === 'admin'
              ? Array.from(new Set([found.warehouseCode || targetWh, WMS_DEFAULT_WAREHOUSE, targetWh]))
              : [found.warehouseCode || WMS_DEFAULT_WAREHOUSE];
          if (!canAccessWarehouse(found.role, allowedWarehouses, targetWh)) {
            const msg = `Operator ${found.username} is not authorized for warehouse ${targetWh}.`;
            setLastAuthError(msg);
            await logAction('WAREHOUSE_SCOPE_DENIED', msg, found.displayName);
            return { ok: false, code: 'WAREHOUSE_FORBIDDEN', message: msg };
          }

          const sessionUser: AuthUser = {
            id: found.id,
            username: found.username,
            role: found.role,
            displayName: found.displayName,
            tenantCode: found.tenantCode || WMS_TENANT_CODE,
            warehouseCode: found.warehouseCode || targetWh,
            allowedWarehouses,
            authMode: 'edge-pbkdf2',
            mustChangePassword: Boolean(found.mustChangePassword),
          };
          await saveLocalLockout(cleanUser, { count: 0, lockedUntil: 0 });

          if (sessionUser.mustChangePassword) {
            setPendingRotation({ user: sessionUser, sessionToken: null });
            await logAction(
              'PASSWORD_ROTATION_REQUIRED',
              `Local credential for ${sessionUser.username} is flagged for mandatory rotation`,
              sessionUser.displayName,
            );
            return {
              ok: false,
              code: 'PASSWORD_CHANGE_REQUIRED',
              message: 'This local credential is flagged for mandatory rotation. Set a new password to continue.',
              mustChangePassword: true,
              pendingUser: sessionUser,
            };
          }

          await persistEncryptedSession(sessionUser, null);
          await logAction('LOGIN_EDGE_SUCCESS', `User ${found.username} authenticated offline (${targetWh})`, found.displayName);
          return { ok: true };
        }
      }

      // Record failed attempt & apply progressive exponential lockout
      const nextCount = localLock.count + 1;
      const lockedUntil =
        nextCount >= MAX_FAILED_ATTEMPTS
          ? Date.now() + Math.min(60, 5 * (nextCount - MAX_FAILED_ATTEMPTS + 1)) * 60_000
          : 0;
      await saveLocalLockout(cleanUser, { count: nextCount, lockedUntil });
      await logAction('LOGIN_FAILED', `Failed login attempt #${nextCount} for ${cleanUser}`, cleanUser);

      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - nextCount);
      const msg =
        lockedUntil > 0
          ? 'Account locked after 5 failed attempts. Please wait 5 minutes or contact an administrator.'
          : `Invalid credentials (${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout).`;
      setLastAuthError(msg);

      return {
        ok: false,
        code: lockedUntil > 0 ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        message: msg,
        remainingAttempts: remaining,
        lockedUntil: lockedUntil > 0 ? new Date(lockedUntil).toISOString() : undefined,
      };
    },
    [persistEncryptedSession]
  );

  const login = useCallback(
    async (username: string, password: string, warehouseCode?: string): Promise<boolean> => {
      const res = await loginDetailed(username, password, warehouseCode);
      return res.ok;
    },
    [loginDetailed]
  );

  const switchWarehouse = useCallback(
    async (warehouseCode: string): Promise<{ ok: boolean; error?: string }> => {
      const current = userRef.current;
      if (!current) return { ok: false, error: 'Not authenticated' };
      const cleanWh = warehouseCode.trim().toUpperCase();
      if (!canAccessWarehouse(current.role, current.allowedWarehouses, cleanWh)) {
        const msg = `Role ${current.role} is not scoped to warehouse ${cleanWh}`;
        await logAction('WAREHOUSE_SWITCH_DENIED', msg, current.displayName);
        return { ok: false, error: msg };
      }

      const token = getActiveServerSessionToken();
      if (token && isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        const { data, error } = await supabase.rpc('wms_validate_session', {
          p_session_token: token,
          p_tenant_code: current.tenantCode,
          p_warehouse_code: cleanWh,
        });
        if (error || !data?.valid) {
          return { ok: false, error: data?.error || error?.message || 'Warehouse validation failed' };
        }
      }

      const updated: AuthUser = { ...current, warehouseCode: cleanWh };
      await persistEncryptedSession(updated, token);
      await logAction('WAREHOUSE_SWITCHED', `Switched active warehouse to ${cleanWh}`, current.displayName);
      return { ok: true };
    },
    [persistEncryptedSession]
  );

  // ─── First-run bootstrap & credential rotation ─────────────────────────

  /**
   * Reports whether this installation still needs its first administrator.
   *
   * Cloud mode asks the service-role-only `wms_get_bootstrap_status` RPC; edge
   * mode falls back to counting local operator accounts.
   */
  const getBootstrapStatus = useCallback(async (): Promise<BootstrapStatus> => {
    if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        const { data, error } = await supabase.rpc('wms_get_bootstrap_status', {
          p_tenant_code: WMS_TENANT_CODE,
        });
        if (!error && data) {
          return {
            bootstrap_required: Boolean(data.bootstrap_required),
            tenant_code: data.tenant_code ?? WMS_TENANT_CODE,
            active_users: Number(data.active_users ?? 0),
            users_requiring_rotation: Number(data.users_requiring_rotation ?? 0),
            bootstrap_completed_at: data.bootstrap_completed_at ?? null,
          };
        }
      } catch {
        // fall through to the local probe
      }
    }
    const needs = await requiresBootstrap();
    return {
      bootstrap_required: needs,
      tenant_code: DEFAULT_TENANT_CODE,
      active_users: 0,
      users_requiring_rotation: 0,
      bootstrap_completed_at: null,
    };
  }, []);

  /**
   * Creates the very first administrator.
   *
   * Cloud mode uses the audited `wms_bootstrap_first_admin` RPC, which closes
   * itself permanently once an active user exists. Edge mode mirrors the same
   * one-shot guarantee locally. Either way the new admin signs in immediately
   * and is flagged for rotation only if the server says so.
   */
  const bootstrapFirstAdmin = useCallback(
    async (input: {
      username: string;
      password: string;
      displayName?: string;
      email?: string;
      warehouseCode?: string;
    }): Promise<LoginOutcome> => {
      const cleanUser = input.username.trim();
      const targetWh = (input.warehouseCode || WMS_DEFAULT_WAREHOUSE).trim().toUpperCase();
      const strength = validatePasswordStrength(input.password, cleanUser);
      if (!strength.ok) {
        return { ok: false, code: 'INVALID_CREDENTIALS', message: strength.error };
      }

      if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        try {
          const { data, error } = await supabase.rpc('wms_bootstrap_first_admin', {
            p_username: cleanUser,
            p_password: input.password,
            p_tenant_code: WMS_TENANT_CODE,
            p_display_name: input.displayName?.trim() || null,
            p_email: input.email?.trim() || null,
            p_warehouse_code: targetWh,
            p_device_id: getDeviceId(),
            p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : 'YESI-WMS',
          });

          if (error) {
            return { ok: false, code: 'INVALID_CREDENTIALS', message: error.message };
          }
          if (!data?.authenticated) {
            return {
              ok: false,
              code: data?.code === 'BOOTSTRAP_ALREADY_COMPLETED' ? 'BOOTSTRAP_REQUIRED' : 'INVALID_CREDENTIALS',
              message: data?.error || 'Bootstrap was refused by the server.',
            };
          }

          const u = data.user ?? {};
          const mappedRole: WmsRole = (['admin', 'supervisor', 'operator', 'auditor', 'viewer'].includes(u.role) ? u.role : 'admin') as WmsRole;
          const sessionUser: AuthUser = {
            id: u.id ?? cleanUser,
            username: u.username || cleanUser,
            role: mappedRole,
            displayName: u.displayName || input.displayName || cleanUser,
            tenantCode: u.tenantCode || WMS_TENANT_CODE,
            warehouseCode: u.warehouseCode || targetWh,
            warehouseName: u.warehouseName || 'Fulfillment Center',
            allowedWarehouses: Array.isArray(u.allowedWarehouses) && u.allowedWarehouses.length > 0 ? u.allowedWarehouses : [targetWh],
            authMode: 'supabase-pgcrypto',
            mustChangePassword: Boolean(data.must_change_password),
            passwordChangedAt: u.passwordChangedAt ?? new Date().toISOString(),
          };

          // Mirror the credential locally so an offline shift can still sign in.
          try {
            const localHash = await hashPasswordLocal(input.password);
            await db.users.add({
              username: sessionUser.username,
              password: localHash,
              role: mappedRole === 'viewer' || mappedRole === 'auditor' ? 'operator' : mappedRole as 'admin' | 'supervisor' | 'operator',
              displayName: sessionUser.displayName,
              createdAt: new Date().toISOString(),
              skillLevel: 5,
              tenantCode: sessionUser.tenantCode,
              warehouseCode: sessionUser.warehouseCode,
              mustChangePassword: false,
              passwordChangedAt: new Date().toISOString(),
              createdBy: 'bootstrap',
            });
          } catch {
            // IndexedDB may be blocked; the cloud session is authoritative.
          }

          setPendingRotation(null);
          await logAction('ADMIN_BOOTSTRAPPED', `First-run administrator ${sessionUser.username} created for ${targetWh}`, sessionUser.displayName);
          await persistEncryptedSession(sessionUser, data.session_token || null);
          return { ok: true };
        } catch {
          // fall through to local bootstrap
        }
      }

      const local = await bootstrapInitialAdmin({
        username: cleanUser,
        password: input.password,
        displayName: input.displayName,
        role: 'admin',
        tenantCode: DEFAULT_TENANT_CODE,
        warehouseCode: targetWh,
      });
      if (!local.ok) {
        return {
          ok: false,
          code: local.code === 'BOOTSTRAP_ALREADY_COMPLETED' ? 'BOOTSTRAP_REQUIRED' : 'INVALID_CREDENTIALS',
          message: local.error,
        };
      }

      const created = await db.users.where('username').equals(cleanUser).first();
      const sessionUser: AuthUser = {
        id: created?.id ?? cleanUser,
        username: cleanUser,
        role: 'admin',
        displayName: input.displayName?.trim() || cleanUser,
        tenantCode: DEFAULT_TENANT_CODE,
        warehouseCode: targetWh,
        allowedWarehouses: [targetWh],
        authMode: 'edge-pbkdf2',
        mustChangePassword: false,
        passwordChangedAt: new Date().toISOString(),
      };
      setPendingRotation(null);
      await persistEncryptedSession(sessionUser, null);
      return { ok: true };
    },
    [persistEncryptedSession],
  );

  /**
   * Rotates the credential of the signed-in operator, or of an operator whose
   * login is pending mandatory rotation.
   *
   * Cloud mode calls `wms_rotate_operator_password` (which clears the
   * `must_change_password` flag and revokes other sessions); edge mode rotates
   * the local PBKDF2 hash. On success a pending operator is promoted to a live
   * session.
   */
  const rotatePassword = useCallback(
    async (input: { currentPassword: string; newPassword: string; username?: string }): Promise<RotatePasswordResult> => {
      const target = pendingRotation?.user ?? userRef.current;
      if (!target) return { ok: false, code: 'AUTH_REQUIRED', message: 'No operator session to rotate' };
      const targetUser = (input.username || target.username).trim();

      const strength = validatePasswordStrength(input.newPassword, targetUser);
      if (!strength.ok) return { ok: false, code: strength.code, message: strength.error };
      if (input.newPassword === input.currentPassword) {
        return { ok: false, code: 'PASSWORD_UNCHANGED', message: 'The new password must differ from the current one' };
      }

      if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        const token = pendingRotation?.sessionToken ?? getActiveServerSessionToken();
        if (!token) {
          return { ok: false, code: 'AUTH_REQUIRED', message: 'A signed session is required to rotate a cloud credential' };
        }
        try {
          const { data, error } = await supabase.rpc('wms_rotate_operator_password', {
            p_session_token: token,
            p_tenant_code: target.tenantCode,
            p_target_username: targetUser,
            p_new_password: input.newPassword,
            p_current_password: input.currentPassword || null,
            p_device_id: getDeviceId(),
          });
          if (error) return { ok: false, code: 'ROTATION_FAILED', message: error.message };
          if (!data?.ok) {
            return { ok: false, code: String(data?.code || 'ROTATION_FAILED'), message: String(data?.error || 'Rotation refused') };
          }
        } catch {
          // Offline mid-rotation: fall through to the local hash update so the
          // operator is never locked out of the floor terminal.
        }
      }

      const local = await rotateLocalPassword(targetUser, input.currentPassword, input.newPassword);
      if (!local.ok && !isSupabaseConfigured) {
        return { ok: false, code: local.code, message: local.error };
      }
      if (!local.ok && local.code !== 'CURRENT_PASSWORD_INVALID' && local.code !== 'USER_NOT_FOUND') {
        return { ok: false, code: local.code, message: local.error };
      }

      const rotated: AuthUser = { ...target, mustChangePassword: false, passwordChangedAt: new Date().toISOString() };
      setPendingRotation(null);
      await persistEncryptedSession(rotated, pendingRotation?.sessionToken ?? getActiveServerSessionToken());
      await logAction('PASSWORD_ROTATED', `Credential rotated for ${targetUser}`, rotated.displayName);
      return { ok: true, message: `Password rotated for ${targetUser}` };
    },
    [pendingRotation, persistEncryptedSession],
  );

  const updateUser = useCallback(
    (updates: Partial<AuthUser>) => {
      setUser((prev) => {
        if (!prev) return null;
        const updated = { ...prev, ...updates };
        void persistEncryptedSession(updated, getActiveServerSessionToken());
        return updated;
      });
    },
    [persistEncryptedSession]
  );

  const can = useCallback(
    (permission: string) => hasPermission(user?.role, permission),
    [user?.role]
  );

  const canAccessModule = useCallback(
    (path: string) => canAccessRoute(user?.role, path),
    [user?.role]
  );

  const contextValue = React.useMemo<AuthContextType>(
    () => ({
      user,
      login,
      loginDetailed,
      logout,
      switchWarehouse,
      mustChangePassword: Boolean(pendingRotation?.user?.mustChangePassword ?? user?.mustChangePassword),
      getBootstrapStatus,
      bootstrapFirstAdmin,
      rotatePassword,
      isAdmin: user?.role === 'admin',
      isSupervisor: user?.role === 'admin' || user?.role === 'supervisor',
      can,
      canAccessModule,
      loading,
      lastAuthError,
      updateUser,
    }),
    [
      user,
      loading,
      lastAuthError,
      login,
      loginDetailed,
      logout,
      switchWarehouse,
      can,
      canAccessModule,
      updateUser,
      pendingRotation,
      getBootstrapStatus,
      bootstrapFirstAdmin,
      rotatePassword,
    ]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
