import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    preferences: {
      where: () => ({ equals: () => ({ first: async () => null }) }),
      add: async () => 1,
      put: async () => 1,
      update: async () => 1,
    },
    outboxEvents: {
      where: () => ({ equals: () => ({ first: async () => null }) }),
      add: async () => 1,
      toArray: async () => [],
    },
    telemetryEvents: { add: async () => 1 },
    stockBalances: { toArray: async () => [] },
    auditLogs: { add: async () => 1 },
  },
  availableQty: (b: { onHandQty: number; reservedQty: number; quarantineQty: number }) =>
    Math.max(0, b.onHandQty - b.reservedQty - b.quarantineQty),
}));

import {
  hashPasswordLocal,
  verifyPasswordLocal,
  isHashedSecret,
  hasPermission,
  canAccessRoute,
  canAccessWarehouse,
  encryptSessionEnvelope,
  decryptSessionEnvelope,
} from '@/lib/security';
import { validateRuntimeConfig } from '@/lib/config';
import { validateOutboxPayload, computeBackoffMs } from '@/lib/supabaseSync';
import { validateScan, buildSummary, type ExpectedLine } from '@/lib/scanValidation';
import { routeOptimizer, oracle, sentinel } from '@/lib/neuralOps';
import { safeLocalStorage, safeSessionStorage } from '@/lib/safeStorage';
import { useAppStore } from '@/lib/store';

describe('WMS Runtime Config & Secret Guardrails', () => {
  it('gracefully enters isolated Offline-Edge Mode when cloud env vars are missing', () => {
    const report = validateRuntimeConfig({});
    expect(report.cloudEnabled).toBe(false);
    expect(report.supabaseUrl).toBeNull();
    expect(report.supabaseAnonKey).toBeNull();
    expect(report.errors).toHaveLength(0);
  });

  it('rejects accidental service_role / secret keys in browser configuration', () => {
    const fakeSecretPrefix = ['sb', 'secret', 'TEST_ONLY_MOCK_KEY_123456'].join('_');
    const report = validateRuntimeConfig({
      VITE_SUPABASE_URL: 'https://demo-wms.example-cloud.invalid',
      VITE_SUPABASE_ANON_KEY: fakeSecretPrefix,
    });
    expect(report.cloudEnabled).toBe(false);
    expect(report.errors.some((e) => e.includes('CRITICAL SECURITY VIOLATION'))).toBe(true);
  });

  it('rejects non-HTTPS Supabase URLs', () => {
    const report = validateRuntimeConfig({
      VITE_SUPABASE_URL: 'http://insecure.local',
      VITE_SUPABASE_ANON_KEY: 'valid_publishable_token_placeholder_1234567890',
    });
    expect(report.cloudEnabled).toBe(false);
    expect(report.errors.some((e) => e.includes('HTTPS'))).toBe(true);
  });
});

describe('WMS Security, AES-GCM Session Envelope & Module RBAC', () => {
  it('hashes passwords with PBKDF2-SHA256 and strictly rejects unhashed plaintext secrets', async () => {
    const hash = await hashPasswordLocal('VINOVJ-Secure-2026');
    expect(isHashedSecret(hash)).toBe(true);
    expect(hash).not.toContain('VINOVJ-Secure-2026');

    expect(await verifyPasswordLocal('VINOVJ-Secure-2026', hash)).toBe(true);
    expect(await verifyPasswordLocal('WrongPassword', hash)).toBe(false);
    // Plaintext stored password must NEVER pass strict verification
    expect(await verifyPasswordLocal('plaintext', 'plaintext')).toBe(false);
  });

  it('encrypts and decrypts session payloads with non-extractable AES-256-GCM', async () => {
    const session = {
      user: { username: 'VINOVJ', role: 'admin', tenantCode: 'YESI-FZCO', warehouseCode: 'DXB-FC1' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const ciphertext = await encryptSessionEnvelope(session);
    expect(ciphertext.startsWith('aes256gcm.')).toBe(true);
    expect(ciphertext).not.toContain('VINOVJ');

    const restored = await decryptSessionEnvelope<typeof session>(ciphertext);
    expect(restored?.user.username).toBe('VINOVJ');
    expect(await decryptSessionEnvelope('aes256gcm.tampered.payload')).toBeNull();
  });

  it('enforces granular module route guards and warehouse-level scoping', () => {
    expect(hasPermission('admin', 'users.delete')).toBe(true);
    expect(hasPermission('supervisor', 'qc.release')).toBe(true);
    expect(hasPermission('supervisor', 'users.manage')).toBe(false);
    expect(hasPermission('operator', 'outbound.pack')).toBe(true);
    expect(hasPermission('operator', 'qc.release')).toBe(false);
    expect(hasPermission('operator', 'inventory.adjust')).toBe(false);

    expect(canAccessRoute('operator', '/inbound')).toBe(true);
    expect(canAccessRoute('operator', '/users')).toBe(false);
    expect(canAccessRoute('operator', '/integrations')).toBe(false);
    expect(canAccessRoute('supervisor', '/integrations')).toBe(true);
    expect(canAccessRoute('viewer', '/pick-pack')).toBe(false);

    expect(canAccessWarehouse('operator', ['DXB-FC1'], 'DXB-FC1')).toBe(true);
    expect(canAccessWarehouse('operator', ['DXB-FC1'], 'MSK-HUB2')).toBe(false);
    expect(canAccessWarehouse('admin', ['DXB-FC1'], 'MSK-HUB2')).toBe(true);
  });
});

describe('WMS Transactional Outbox Validation & Retry Backoff', () => {
  it('rejects malformed outbox payloads and accepts valid lifecycle events', () => {
    expect(validateOutboxPayload('inbound_grn', { sku: '', qty: 5 }).valid).toBe(false);
    expect(validateOutboxPayload('inbound_grn', { sku: 'A17Black256', qty: -2 }).valid).toBe(false);
    // Receiving without an exact bin + lot would create an ambiguous stock
    // dimension, so it is rejected rather than defaulted silently.
    expect(validateOutboxPayload('inbound_grn', { sku: 'A17Black256', qty: 5 }).valid).toBe(false);
    expect(
      validateOutboxPayload('inbound_grn', {
        sku: 'A17Black256',
        qty: 5,
        bin: 'RECV-DOCK-01',
        lotNumber: 'LOT-2026-11',
      }).valid,
    ).toBe(true);

    expect(validateOutboxPayload('qc_release', { sku: 'A17', qty: 2, disposition: 'invalid' }).valid).toBe(false);
    expect(validateOutboxPayload('qc_release', { sku: 'A17', qty: 2, disposition: 'release' }).valid).toBe(true);

    expect(validateOutboxPayload('dispatch_order', {}).valid).toBe(false);
    expect(validateOutboxPayload('dispatch_order', { orderId: 'ORD-1001' }).valid).toBe(true);
  });

  it('requires an exact stock dimension on every stock movement', () => {
    expect(validateOutboxPayload('stock_movement', { sku: 'A17', qtyDelta: 2, transactionType: 'adjustment' }).valid).toBe(false);
    expect(
      validateOutboxPayload('stock_movement', {
        sku: 'A17',
        qtyDelta: 2,
        transactionType: 'adjustment',
        location: 'PHONE-A-01-01',
        lotNumber: 'LOT-2026-11',
      }).valid,
    ).toBe(true);
    expect(
      validateOutboxPayload('stock_movement', {
        sku: 'A17',
        qtyDelta: 2,
        transactionType: 'adjustment',
        location: 'PHONE-A-01-01',
        lotNumber: 'LOT-2026-11',
        stockStatus: 'SELLABLE',
      }).valid,
    ).toBe(false);
    expect(
      validateOutboxPayload('stock_movement', {
        sku: 'A17',
        qtyDelta: 2,
        transactionType: 'adjustment',
        location: 'PHONE-A-01-01',
        lotNumber: 'LOT-2026-11',
        stockStatus: 'QUARANTINE',
      }).valid,
    ).toBe(true);
    expect(validateOutboxPayload('stock_movement', { sku: 'A17', qtyDelta: 0, transactionType: 'adjustment', location: 'A', lotNumber: 'L' }).valid).toBe(false);
  });

  it('refuses to queue a pick confirmation without a scanned barcode', () => {
    expect(validateOutboxPayload('confirm_pick', { taskNumber: 'PT-1' }).valid).toBe(false);
    expect(validateOutboxPayload('confirm_pick', { taskNumber: 'PT-1', scannedCode: '' }).valid).toBe(false);
    expect(validateOutboxPayload('confirm_pick', { taskNumber: 'PT-1', scannedCode: '3589120400001' }).valid).toBe(true);
    expect(validateOutboxPayload('confirm_pick', { taskNumber: 'PT-1', scannedCode: '3589120400001', pickedQty: 0 }).valid).toBe(false);
    expect(validateOutboxPayload('confirm_pick', { taskNumber: 'PT-1', scannedCode: '3589120400001', pickedQty: 2 }).valid).toBe(true);
  });

  it('computes exponential backoff with bounded ceiling', () => {
    const b1 = computeBackoffMs(1);
    const b4 = computeBackoffMs(4);
    expect(b1).toBeGreaterThanOrEqual(1500);
    expect(b4).toBeGreaterThan(b1);
    expect(computeBackoffMs(20)).toBeLessThanOrEqual(301_000);
  });
});

describe('WMS Scan Validation & Wave Accuracy', () => {
  const expected: ExpectedLine[] = [
    { trackingId: '78954582-0287-1', product: 'Samsung Galaxy A17', qty: 1 },
    { trackingId: '56848324-0106-1', product: 'Galaxy Watch 8', qty: 2 },
  ];

  it('validates expected scans, partial multi-unit scans, duplicates, and unknown barcodes', () => {
    const counts = new Map<string, number>();

    const ev1 = validateScan('78954582-0287-1', expected, counts);
    expect(ev1.verdict).toBe('VALID');
    counts.set('78954582-0287-1', 1);

    const evDup = validateScan('78954582-0287-1', expected, counts);
    expect(evDup.verdict).toBe('QTY_EXCEEDED');

    const evPart = validateScan('56848324-0106-1', expected, counts);
    expect(evPart.verdict).toBe('PARTIAL');
    counts.set('56848324-0106-1', 1);

    const evFull = validateScan('56848324-0106-1', expected, counts);
    expect(evFull.verdict).toBe('VALID');
    counts.set('56848324-0106-1', 2);

    const evUnknown = validateScan('99999999-0000-9', expected, counts);
    expect(evUnknown.verdict).toBe('UNKNOWN_ORDER');

    const summary = buildSummary(expected, [ev1, evPart, evFull]);
    expect(summary.missing).toHaveLength(0);
    expect(summary.valid).toBe(3);
  });
});

describe('WMS Quantum Route Optimizer, Oracle Forecast & Anomaly Sentinel', () => {
  it('optimizes multi-SKU pick route using nearest-neighbor + 2-opt', () => {
    const route = routeOptimizer.optimizeRoute([
      'Buds3ProSilver',
      'A17Black256',
      'Watch8Graphite40',
      'sS25FEWhite',
    ]);
    expect(route).toHaveLength(4);
    expect(route.every((p) => p.zone && p.x > 0 && p.y > 0)).toBe(true);
  });

  it('generates 7-day demand forecast and detects stock anomalies', () => {
    const forecast = oracle.forecast(7, 207);
    expect(forecast).not.toBeNull();
    expect(forecast!.forecast).toHaveLength(7);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(forecast!.stockoutRisk);

    const alerts = sentinel.scan(
      [
        { sku: 'SKU-NEG', stock: -2 },
        { sku: 'SKU-LOW', stock: 1 },
        { sku: 'SKU-OK-1', stock: 25 },
        { sku: 'SKU-OK-2', stock: 28 },
        { sku: 'SKU-OK-3', stock: 22 },
      ],
      [{ status: 'Open' }]
    );
    expect(alerts.some((a) => a.sku === 'SKU-NEG')).toBe(true);
  });
});

describe('Sandboxed Iframe Storage Resilience (safeStorage & Zustand Persist)', () => {
  it('never throws SecurityError when localStorage / sessionStorage are blocked in cross-origin iframes', () => {
    const throwingStorage: Storage = {
      length: 0,
      clear() { throw new DOMException('', 'SecurityError'); },
      getItem() { throw new DOMException('', 'SecurityError'); },
      key() { throw new DOMException('', 'SecurityError'); },
      removeItem() { throw new DOMException('', 'SecurityError'); },
      setItem() { throw new DOMException('', 'SecurityError'); },
    };

    vi.stubGlobal('window', {
      localStorage: throwingStorage,
      sessionStorage: throwingStorage,
    });

    expect(() => safeLocalStorage.setItem('test_k', 'v1')).not.toThrow();
    expect(safeLocalStorage.getItem('test_k')).toBe('v1');
    expect(() => safeSessionStorage.setItem('sess_k', 's1')).not.toThrow();
    expect(safeSessionStorage.getItem('sess_k')).toBe('s1');

    // Mutating Zustand store actions under blocked Web Storage must never throw or crash React
    expect(() => useAppStore.getState().setAiAssistantOpen(true)).not.toThrow();
    expect(useAppStore.getState().aiAssistantOpen).toBe(true);
    expect(() => useAppStore.getState().setDensity('comfortable')).not.toThrow();
    expect(useAppStore.getState().density).toBe('comfortable');

    vi.unstubAllGlobals();
  });
});
