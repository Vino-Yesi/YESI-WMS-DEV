/**
 * Cryptographic Security, AES-GCM Session Envelope & Module-Level RBAC Engine
 *
 * Enterprise security controls:
 *  1. PBKDF2-SHA256 (120,000 iterations) constant-time local password verification.
 *  2. Non-extractable Web Crypto AES-GCM-256 session encryption (stored in IndexedDB
 *     CryptoKey + sessionStorage ciphertext; zero plaintext session data in localStorage).
 *  3. Granular per-module permission matrix + route guards + warehouse-level scoping.
 */

const ITERATIONS = 120_000;
const HASH_PREFIX = 'pbkdf2_sha256$';
const KEY_DB_NAME = 'yesi_wms_keystore_v1';
const KEY_STORE_NAME = 'keys';
const SESSION_KEY_ID = 'aes_gcm_session_key';

/**
 * Browsers only expose `crypto.subtle` in a secure context (HTTPS, localhost, or
 * a desktop webview origin they treat as trusted). On a plain-HTTP host it is
 * `undefined`, and every PBKDF2/AES-GCM call below dies with a TypeError that
 * says nothing about the real cause ("Cannot read properties of undefined
 * (reading 'importKey')"). Fail with an error that names the cause and the fix
 * instead, so operators and the boot banner can act on it.
 */
export function assertSecureCrypto(): void {
  if (typeof crypto === 'undefined' || crypto.subtle == null) {
    throw new Error(
      'INSECURE_CONTEXT: this page is not in a secure context (HTTPS or localhost), so the browser withholds Web Crypto. ' +
        'Password hashing and the encrypted session envelope cannot run here. Serve YESI-WMS over TLS — see ' +
        'docs/BUILD-DEVELOP-DEPLOY-SOP.md, "Before any deploy" — then reload.',
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function isHashedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(HASH_PREFIX);
}

export async function hashPasswordLocal(password: string): Promise<string> {
  assertSecureCrypto();
  if (isHashedSecret(password)) return password;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const digest = new Uint8Array(bits);
  return `${HASH_PREFIX}${ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(digest)}`;
}

/**
 * Strict PBKDF2-SHA256 verification. Rejects unhashed plaintext secrets so
 * legacy or tampered plaintext records can never bypass hashing.
 */
export async function verifyPasswordLocal(password: string, stored: string): Promise<boolean> {
  assertSecureCrypto();
  if (!stored || !isHashedSecret(stored)) {
    return false;
  }
  try {
    const body = stored.slice(HASH_PREFIX.length);
    const [iterStr, saltHex, expectedHex] = body.split('$');
    const iterations = parseInt(iterStr, 10) || ITERATIONS;
    if (iterations < 10_000 || !saltHex || !expectedHex) return false;
    const salt = hexToBytes(saltHex);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    const computedHex = bytesToHex(new Uint8Array(bits));
    if (computedHex.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < computedHex.length; i++) {
      diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ─── Non-Extractable AES-GCM-256 Session Envelope ──────────────────────────

let fallbackMemoryKey: CryptoKey | null = null;

async function getOrCreateSessionCryptoKey(): Promise<CryptoKey> {
  assertSecureCrypto();
  const getFallbackKey = async () => {
    if (!fallbackMemoryKey) {
      fallbackMemoryKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }
    return fallbackMemoryKey;
  };

  if (typeof indexedDB === 'undefined') {
    return getFallbackKey();
  }

  try {
    return await new Promise<CryptoKey>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(KEY_DB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(KEY_STORE_NAME)) {
          idb.createObjectStore(KEY_STORE_NAME);
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const idb = req.result;
        const tx = idb.transaction(KEY_STORE_NAME, 'readonly');
        const getReq = tx.objectStore(KEY_STORE_NAME).get(SESSION_KEY_ID);
        getReq.onsuccess = async () => {
          if (getReq.result) {
            idb.close();
            resolve(getReq.result as CryptoKey);
            return;
          }
          try {
            // Non-extractable key: raw key bytes cannot be exported even by JS
            const newKey = await crypto.subtle.generateKey(
              { name: 'AES-GCM', length: 256 },
              false,
              ['encrypt', 'decrypt']
            );
            const writeTx = idb.transaction(KEY_STORE_NAME, 'readwrite');
            writeTx.objectStore(KEY_STORE_NAME).put(newKey, SESSION_KEY_ID);
            writeTx.oncomplete = () => {
              idb.close();
              resolve(newKey);
            };
            writeTx.onerror = () => {
              idb.close();
              resolve(newKey);
            };
          } catch (err) {
            idb.close();
            reject(err);
          }
        };
        getReq.onerror = () => {
          idb.close();
          reject(getReq.error);
        };
      };
    });
  } catch {
    return getFallbackKey();
  }
}

export async function encryptSessionEnvelope(payload: unknown): Promise<string> {
  const key = await getOrCreateSessionCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encoded
  );
  return `aes256gcm.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuf))}`;
}

export async function decryptSessionEnvelope<T>(envelope: string): Promise<T | null> {
  if (!envelope || !envelope.startsWith('aes256gcm.')) return null;
  try {
    const [, ivB64, dataB64] = envelope.split('.');
    if (!ivB64 || !dataB64) return null;
    const key = await getOrCreateSessionCryptoKey();
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) as BufferSource },
      key,
      base64ToBytes(dataB64) as BufferSource
    );
    const json = new TextDecoder().decode(plainBuf);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ─── Module-Level RBAC & Warehouse Scoping ─────────────────────────────────

export type WmsRole = 'admin' | 'supervisor' | 'operator' | 'auditor' | 'viewer';

export type WmsPermission =
  | 'dashboard.view'
  | 'daily.execute'
  | 'workflow.view'
  | 'cloud.view'
  | 'cloud.manage'
  | 'guardian.view'
  | 'dock.view'
  | 'dock.manage'
  | 'inbound.execute'
  | 'inbound.manage'
  | 'qc.inspect'
  | 'qc.release'
  | 'putaway.execute'
  | 'putaway.manage'
  | 'inventory.view'
  | 'inventory.adjust'
  | 'inventory.manage'
  | 'serial.track'
  | 'cycle_count.execute'
  | 'cycle_count.approve'
  | 'replenishment.execute'
  | 'replenishment.manage'
  | 'outbound.execute'
  | 'outbound.pack'
  | 'outbound.ship'
  | 'outbound.override'
  | 'outbound.manage'
  | 'returns.execute'
  | 'returns.manage'
  | 'tools.use'
  | 'integrations.view'
  | 'integrations.manage'
  | 'labor.view'
  | 'labor.manage'
  | 'reports.view'
  | 'memory.manage'
  | 'audit.view'
  | 'users.manage'
  | 'users.delete'
  | 'settings.manage';

export const ROLE_PERMISSIONS: Record<WmsRole, string[]> = {
  admin: ['*'],
  supervisor: [
    'dashboard.view',
    'daily.execute',
    'workflow.view',
    'cloud.view',
    'guardian.view',
    'dock.view',
    'dock.manage',
    'inbound.execute',
    'inbound.manage',
    'qc.inspect',
    'qc.release',
    'putaway.execute',
    'putaway.manage',
    'inventory.view',
    'inventory.adjust',
    'inventory.manage',
    'serial.track',
    'cycle_count.execute',
    'cycle_count.approve',
    'replenishment.execute',
    'replenishment.manage',
    'outbound.execute',
    'outbound.pack',
    'outbound.ship',
    'outbound.override',
    'outbound.manage',
    'returns.execute',
    'returns.manage',
    'tools.use',
    'integrations.view',
    'integrations.manage',
    'labor.view',
    'labor.manage',
    'reports.view',
    'memory.manage',
    'audit.view',
    'settings.manage',
  ],
  operator: [
    'dashboard.view',
    'daily.execute',
    'workflow.view',
    'dock.view',
    'inbound.execute',
    'qc.inspect',
    'putaway.execute',
    'inventory.view',
    'serial.track',
    'cycle_count.execute',
    'replenishment.execute',
    'outbound.execute',
    'outbound.pack',
    'outbound.ship',
    'returns.execute',
    'tools.use',
  ],
  auditor: [
    'dashboard.view',
    'workflow.view',
    'cloud.view',
    'guardian.view',
    'inventory.view',
    'serial.track',
    'cycle_count.execute',
    'cycle_count.approve',
    'qc.inspect',
    'audit.view',
    'reports.view',
  ],
  viewer: [
    'dashboard.view',
    'workflow.view',
    'inventory.view',
    'reports.view',
  ],
};

/** Route-to-required-permission map for strict per-module route guards */
export const ROUTE_PERMISSIONS: Record<string, WmsPermission> = {
  '/': 'dashboard.view',
  '/dashboard': 'dashboard.view',
  '/daily': 'daily.execute',
  '/workflow': 'workflow.view',
  '/cloud': 'cloud.view',
  '/guardian': 'guardian.view',
  '/dock': 'dock.view',
  '/inbound': 'inbound.execute',
  '/qc': 'qc.inspect',
  '/putaway': 'putaway.execute',
  '/inventory': 'inventory.view',
  '/serial-tracking': 'serial.track',
  '/cycle-count': 'cycle_count.execute',
  '/replenishment': 'replenishment.execute',
  '/barcode-generator': 'tools.use',
  '/barcode-scanner': 'tools.use',
  '/pick-pack': 'outbound.execute',
  '/batch-pick': 'outbound.execute',
  '/shipping': 'outbound.ship',
  '/posting': 'outbound.ship',
  '/returns': 'returns.execute',
  '/pdf-sequencer': 'tools.use',
  '/templates': 'tools.use',
  '/bulk-convert': 'tools.use',
  '/auditor': 'outbound.pack',
  '/sim-manager': 'tools.use',
  '/gsheet': 'tools.use',
  '/ozon-sheets': 'tools.use',
  '/integrations': 'integrations.manage',
  '/labor': 'labor.manage',
  '/analytics': 'reports.view',
  '/memory': 'memory.manage',
  '/users': 'users.manage',
  '/settings': 'dashboard.view',
};

export function hasPermission(role: string | undefined, permission: string): boolean {
  const r = (role || 'viewer') as WmsRole;
  const perms = ROLE_PERMISSIONS[r] || [];
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

export function canAccessRoute(role: string | undefined, path: string): boolean {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const required = ROUTE_PERMISSIONS[normalized];
  if (!required) return Boolean(role);
  return hasPermission(role, required);
}

export function canAccessWarehouse(
  role: string | undefined,
  allowedWarehouses: string[] | undefined,
  warehouseCode: string
): boolean {
  if (!warehouseCode) return false;
  if (role === 'admin') return true;
  if (!allowedWarehouses || allowedWarehouses.length === 0) return false;
  return allowedWarehouses.map((w) => w.toUpperCase()).includes(warehouseCode.trim().toUpperCase());
}
