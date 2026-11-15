import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';

import {
  db,
  availableQty,
  validatePasswordStrength,
  bootstrapInitialAdmin,
  requiresBootstrap,
  rotateLocalPassword,
  seedDatabase,
  DEMO_SEED_ENABLED,
  DEFAULT_TENANT_CODE,
  DEFAULT_WAREHOUSE_CODE,
  type StockBalance,
} from '@/lib/db';
import { isHashedSecret } from '@/lib/security';

const TENANT = DEFAULT_TENANT_CODE;
const WH_A = DEFAULT_WAREHOUSE_CODE;
const WH_B = 'SHJ-HUB2';

function balanceRow(over: Partial<StockBalance> = {}): StockBalance {
  return {
    tenantCode: TENANT,
    warehouseCode: WH_A,
    location: 'PHONE-A-01-01',
    sku: 'A17Black256',
    lotNumber: 'LOT-2026-11',
    stockStatus: 'AVAILABLE',
    onHandQty: 10,
    reservedQty: 0,
    quarantineQty: 0,
    expiryDate: null,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeAll(async () => {
  await db.open();
});

describe('Dexie v10 schema: multi-dimensional stock tables', () => {
  it('creates stockBalances, outboxEvents and telemetryEvents with tenancy indexes', async () => {
    expect(db.verno).toBeGreaterThanOrEqual(10);
    const names = db.tables.map((t) => t.name);
    expect(names).toContain('stockBalances');
    expect(names).toContain('outboxEvents');
    expect(names).toContain('telemetryEvents');

    const balanceIndexes = db.table('stockBalances').schema.indexes.map((i) => i.name);
    // Compound index names carry their brackets in Dexie's schema metadata.
    expect(balanceIndexes).toContain('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]');
    expect(balanceIndexes).toContain('[tenantCode+warehouseCode]');
    const dimensionKey = db.table('stockBalances').schema.indexes.find(
      (i) => i.name === '[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]',
    );
    expect(dimensionKey?.unique).toBe(true);

    const outboxIndexes = db.table('outboxEvents').schema.indexes.map((i) => i.name);
    expect(outboxIndexes).toContain('eventId');
    expect(outboxIndexes).toContain('idempotencyKey');
    expect(outboxIndexes).toContain('[tenantCode+warehouseCode+status]');
    expect(outboxIndexes).toContain('nextRetryAt');
    expect(outboxIndexes).toContain('leaseUntil');

    const invIndexes = db.table('inventory').schema.indexes.map((i) => i.name);
    expect(invIndexes).toContain('[tenantCode+warehouseCode]');
    expect(invIndexes).toContain('[warehouseCode+sku]');

    const orderIndexes = db.table('orders').schema.indexes.map((i) => i.name);
    expect(orderIndexes).toContain('[tenantCode+warehouseCode+status]');
    expect(orderIndexes).toContain('shippedAt');
  });

  it('stores the same SKU in two bins as two rows and never collapses them', async () => {
    await db.stockBalances.clear();
    await db.stockBalances.bulkAdd([
      balanceRow({ location: 'PHONE-A-01-01', onHandQty: 10 }),
      balanceRow({ location: 'PHONE-A-02-03', onHandQty: 4, lotNumber: 'LOT-2026-11B' }),
      balanceRow({ location: 'PHONE-A-01-01', stockStatus: 'QUARANTINE', onHandQty: 2, quarantineQty: 2 }),
    ]);

    const rows = await db.stockBalances.where('sku').equals('A17Black256').toArray();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.location)).size).toBe(2);
    expect(rows.filter((r) => r.stockStatus === 'QUARANTINE')).toHaveLength(1);

    // Bin/lot/status scoped lookup resolves exactly one physical dimension.
    const exact = await db.stockBalances
      .where('[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus]')
      .equals([TENANT, WH_A, 'PHONE-A-02-03', 'A17Black256', 'LOT-2026-11B', 'AVAILABLE'])
      .first();
    expect(exact?.onHandQty).toBe(4);
  });

  it('never mixes warehouses: a scoped query sees only its own site', async () => {
    await db.stockBalances.bulkAdd([
      balanceRow({ warehouseCode: WH_B, location: 'SHJ-B-01', sku: 'A17Black256', onHandQty: 7 }),
    ]);

    const aRows = await db.stockBalances.where('[tenantCode+warehouseCode]').equals([TENANT, WH_A]).toArray();
    const bRows = await db.stockBalances.where('[tenantCode+warehouseCode]').equals([TENANT, WH_B]).toArray();

    expect(aRows.every((r) => r.warehouseCode === WH_A)).toBe(true);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].onHandQty).toBe(7);
    expect(aRows.reduce((sum, r) => sum + r.onHandQty, 0)).not.toBe(
      aRows.reduce((sum, r) => sum + r.onHandQty, 0) + bRows[0].onHandQty,
    );
  });

  it('computes sellable availability as on-hand minus reserved minus quarantine', () => {
    expect(availableQty({ onHandQty: 10, reservedQty: 3, quarantineQty: 2 })).toBe(5);
    expect(availableQty({ onHandQty: 2, reservedQty: 5, quarantineQty: 0 })).toBe(0);
    expect(availableQty({ onHandQty: 0, reservedQty: 0, quarantineQty: 0 })).toBe(0);
  });
});

describe('First-run administrator bootstrap', () => {
  it('enforces the server-side password policy locally', () => {
    expect(validatePasswordStrength('short1', 'op').ok).toBe(false);
    expect(validatePasswordStrength('alllowercaseonly', 'op').ok).toBe(false);
    expect(validatePasswordStrength('Operator01', 'Operator01').ok).toBe(false);
    expect(validatePasswordStrength('password123', 'op').ok).toBe(false);
    expect(validatePasswordStrength('Str0ng-Passphrase!', 'op').ok).toBe(true);
  });

  it('bootstraps exactly one first admin and then closes permanently', async () => {
    await db.users.clear();
    expect(await requiresBootstrap()).toBe(true);

    const rejected = await bootstrapInitialAdmin({ username: 'ab', password: 'Str0ng-Passphrase!' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('INVALID_USERNAME');

    const weak = await bootstrapInitialAdmin({ username: 'floor.admin', password: 'admin' });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.code).toBe('PASSWORD_TOO_SHORT');
    expect(await db.users.count()).toBe(0);

    const first = await bootstrapInitialAdmin({
      username: 'floor.admin',
      password: 'Str0ng-Passphrase!',
      displayName: 'Floor Admin',
    });
    expect(first.ok).toBe(true);
    expect(await requiresBootstrap()).toBe(false);

    // Second bootstrap attempt must be refused, not overwrite the first admin.
    const second = await bootstrapInitialAdmin({ username: 'attacker', password: 'An0ther-Passphrase!' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('BOOTSTRAP_ALREADY_COMPLETED');
    expect(await db.users.count()).toBe(1);

    const admin = await db.users.where('username').equals('floor.admin').first();
    expect(admin?.role).toBe('admin');
    expect(isHashedSecret(admin?.password)).toBe(true);
    expect(admin?.tenantCode).toBe(TENANT);
    expect(admin?.warehouseCode).toBe(WH_A);
  });

  it('rotates a local credential only with the correct current password', async () => {
    const wrong = await rotateLocalPassword('floor.admin', 'Wrong-Current1!', 'Brand-New-Pass1!');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('CURRENT_PASSWORD_INVALID');

    const ok = await rotateLocalPassword('floor.admin', 'Str0ng-Passphrase!', 'Brand-New-Pass1!');
    expect(ok.ok).toBe(true);
    const user = await db.users.where('username').equals('floor.admin').first();
    expect(user?.mustChangePassword).toBe(false);
  });
});

describe('Production seed gating', () => {
  it('never fabricates credentials that equal their username', async () => {
    await db.users.clear();
    await db.inventory.clear();
    const result = await seedDatabase();

    expect(typeof result.demoSeeded).toBe('boolean');
    expect(result.demoSeeded).toBe(DEMO_SEED_ENABLED);

    const users = await db.users.toArray();
    for (const u of users) {
      expect(isHashedSecret(u.password)).toBe(true);
      expect(u.password.toLowerCase()).not.toContain(u.username.toLowerCase());
    }

    // Reference data must exist even when the demo dataset is disabled.
    expect(await db.zoneCapacities.count()).toBeGreaterThan(0);
    expect(await db.boxSizes.count()).toBeGreaterThan(0);
    expect(await db.carrierRates.count()).toBeGreaterThan(0);
  });
});
