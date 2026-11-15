import Dexie, { type Table } from 'dexie';
import waveData from '@/data/ozon-wave.json';
import { hashPasswordLocal, isHashedSecret, verifyPasswordLocal } from './security';
import { runtimeConfig } from './config';
import { enqueueCloudOperation } from './supabaseSync';

/**
 * Active tenancy defaults. Every locally-stored operational row is tagged with
 * both values so a warehouse switch can never leak or mutate another site's
 * stock, orders or movements.
 */
export const DEFAULT_TENANT_CODE: string = runtimeConfig.tenantCode;
export const DEFAULT_WAREHOUSE_CODE: string = runtimeConfig.defaultWarehouseCode;

// ─── Existing interfaces (enhanced) ─────────────────────────────────────
export interface InventoryItem {
  id?: number;
  sku: string;
  product: string;
  stock: number;
  location: string;
  category?: string;
  velocity?: 'high' | 'medium' | 'low';
  weight?: number;
  reorderPoint?: number;
  reorderQty?: number;
  updatedAt: string;
  // NEW: Traceability & barcode
  barcode?: string;
  rfidTag?: string;
  length?: number;
  width?: number;
  height?: number;
  costPerUnit?: number;
  // NEW: Lot / Batch / Expiry
  lotNumber?: string;
  batchNumber?: string;
  expiryDate?: string;
  manufacturingDate?: string;
  serializable?: boolean;
  // NEW: FEFO/FIFO control
  fefoPriority?: number; // higher = ship first
  // v10: tenancy scope (rows are per tenant+warehouse, never global)
  tenantCode?: string;
  warehouseCode?: string;
  // v10: derived rollup over `stockBalances` for this warehouse. `stock` stays
  // the on-hand total; these expose the sellable / blocked split and the number
  // of distinct bins and lots actually holding the SKU.
  availableStock?: number;
  reservedStock?: number;
  quarantineStock?: number;
  binCount?: number;
  lotNumbers?: string[];
  earliestExpiry?: string | null;
}

export interface Order {
  id?: number;
  orderId: string;
  status: 'Pending' | 'Shipped' | 'Returned' | 'Cancelled' | 'QCHold' | 'CrossDock' | 'Packed' | 'Picking' | 'ReadyToShip';
  requiredSkus: string;
  priority: 'normal' | 'high' | 'urgent';
  createdAt: string;
  updatedAt: string;
  assignedTo?: string;
  waveId?: string;
  batchId?: string;
  // NEW: Shipping
  carrier?: string;
  service?: string;
  trackingNumber?: string;
  shippingCost?: number;
  weightTotal?: number;
  dimensionsTotal?: string; // JSON of dims
  // NEW: Box sizing
  suggestedBoxSize?: string;
  actualBoxSize?: string;
  packingMaterials?: string;
  // v10: tenancy scope + real dispatch timestamp (drives "shipped today")
  tenantCode?: string;
  warehouseCode?: string;
  shippedAt?: string | null;
  channel?: string;
}

export interface ReturnRecord {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  orderId: string;
  sku: string;
  reason: string;
  restocked: boolean;
  quantity: number;
  processedAt: string;
}

export interface InboundRecord {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  sku: string;
  qty: number;
  bin: string;
  description: string;
  lotNumber?: string;
  serialNumbers?: string;
  expiryDate?: string;
  receivedAt: string;
  crossDockOrderId?: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  // NEW: PO reconciliation
  poNumber?: string;
  supplier?: string;
  expectedQty?: number;
  variance?: number;
  putawayLocation?: string;
  putawayReason?: string;
}

export interface AuditLog {
  id?: number;
  action: string;
  details: string;
  operator: string;
  timestamp: string;
}

export interface User {
  id?: number;
  username: string;
  password: string;
  role: 'admin' | 'operator' | 'supervisor';
  displayName: string;
  createdAt: string;
  // NEW: Labor
  skillLevel?: number; // 1-5
  preferredTaskTypes?: string; // JSON
  currentZone?: string;
  // v10: tenancy scope + first-run bootstrap / forced rotation
  tenantCode?: string;
  warehouseCode?: string;
  mustChangePassword?: boolean;
  passwordChangedAt?: string | null;
  createdBy?: string | null;
}

export interface InventoryMovement {
  id?: number;
  sku: string;
  type: 'inbound' | 'outbound' | 'return' | 'adjustment' | 'transfer' | 'cycle_count' | 'qc_adjustment' | 'putaway' | 'pick' | 'pack';
  quantity: number;
  fromLocation?: string;
  toLocation?: string;
  orderId?: string;
  operator: string;
  lotNumber?: string;
  note?: string;
  timestamp: string;
  // v10: exact stock dimension the movement touched + tenancy scope
  tenantCode?: string;
  warehouseCode?: string;
  stockStatus?: StockStatus;
  serialNumber?: string;
  expiryDate?: string | null;
  idempotencyKey?: string;
  cloudAccepted?: boolean;
}

export interface CycleCount {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  sku: string;
  location: string;
  expectedQty: number;
  actualQty: number;
  variance: number;
  status: 'pending' | 'completed' | 'rejected' | 'approved';
  operator: string;
  countedAt: string;
  note?: string;
  // NEW: ABC classification
  abcClass?: 'A' | 'B' | 'C';
  countFrequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  nextScheduled?: string;
}

export interface ZoneCapacity {
  id?: number;
  zone: string;
  maxCapacity: number;
  currentUtilization: number;
  category?: string;
  velocityTarget?: 'high' | 'medium' | 'low';
  // NEW: Bin details
  aisle?: string;
  rack?: string;
  shelf?: string;
  binType?: 'pallet' | 'carton' | 'shelf' | 'floor' | 'cold';
  maxWeight?: number;
  // NEW: Putaway rules
  putawayRules?: string; // JSON of rules
}

export interface WorkerTask {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  type: 'pick' | 'pack' | 'receive' | 'putaway' | 'cycle_count' | 'replenish' | 'ship' | 'label' | 'audit';
  orderId?: string;
  sku?: string;
  fromLocation?: string;
  toLocation?: string;
  quantity: number;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  assignedTo: string;
  priority: 'normal' | 'high' | 'urgent';
  createdAt: string;
  completedAt?: string;
  note?: string;
  // NEW: Performance
  estimatedTime?: number; // minutes
  actualTime?: number; // minutes
  distance?: number; // meters walked
  pickPath?: string; // JSON array of locations
}

export interface ReplenishmentTask {
  id?: number;
  sku: string;
  fromLocation: string;
  toLocation: string;
  quantity: number;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'normal' | 'high';
  createdAt: string;
  completedAt?: string;
  triggeredBy?: 'auto' | 'manual' | 'low_stock' | 'wave_demand';
}

export interface QCHold {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  sku: string;
  lotNumber?: string;
  /** Physical bin holding the blocked units (drives QUARANTINE dimension moves). */
  location?: string;
  quantity: number;
  reason: string;
  status: 'hold' | 'released' | 'rejected';
  operator: string;
  createdAt: string;
  releasedAt?: string;
}

export interface WaveBatch {
  id?: number;
  waveId: string;
  name: string;
  status: 'open' | 'picking' | 'completed' | 'cancelled';
  orderIds: string;
  zoneProfile: string;
  createdAt: string;
  completedAt?: string;
  // NEW: Optimization
  pickPath?: string; // JSON
  estimatedTime?: number;
  actualTime?: number;
  pickerId?: string;
}


/** Stored Google Sheet links with daily expected / packed metrics */
export interface GSheetEntry {
  id?: number;
  name: string;
  url: string;
  /** ISO date YYYY-MM-DD for the operating day */
  day: string;
  expectedOrders: number;
  expectedQty: number;
  packedOrders: number;
  packedQty: number;
  note?: string;
  operator?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id?: number;
  raw: string;
  standard: string;
  createdAt: string;
}

export interface QuickNote {
  id?: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  operator?: string;
  pinned?: boolean;
}

export interface Alias {
  id?: number;
  source: string;
  target: string;
  createdAt: string;
}

export interface Preference {
  id?: number;
  key: string;
  value: string;
  createdAt: string;
}

export interface PostingRecord {
  id?: number;
  postingId: string;
  trackingId?: string;
  orderId?: string;
  status: 'received' | 'in_transit' | 'delivered' | 'posted' | 'exception';
  carrier?: string;
  photoData?: string;
  videoData?: string;
  geolocation?: string;
  city?: string;
  note?: string;
  operator: string;
  createdAt: string;
  folder?: string;
}

export interface SimDbEntry {
  id?: number;
  tacPrefix: string;
  expectedOffset: number;
  modelSeries: string;
  type: string;
}

// ─── NEW: Purchase Order ────────────────────────────────────────────────
export interface PurchaseOrder {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  poNumber: string;
  supplier: string;
  status: 'open' | 'partial' | 'received' | 'closed' | 'cancelled';
  expectedDelivery: string;
  items: string; // JSON: [{sku, qty, expected, received}]
  totalValue: number;
  currency: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── NEW: Shipping Label ───────────────────────────────────────────────
export interface ShippingLabel {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  orderId: string;
  carrier: string;
  service: string;
  trackingNumber: string;
  labelData: string; // base64 PNG or URL
  weight: number;
  dimensions: string; // JSON
  cost: number;
  status: 'draft' | 'printed' | 'void';
  printedAt?: string;
  createdAt: string;
}

// ─── NEW: Carrier Rate ────────────────────────────────────────────────
export interface CarrierRate {
  id?: number;
  carrier: string;
  service: string;
  weightFrom: number;
  weightTo: number;
  zone: string;
  rate: number;
  currency: string;
  estimatedDays: number;
  active: boolean;
}

// ─── NEW: Worker Performance ──────────────────────────────────────────
export interface WorkerPerformance {
  id?: number;
  workerId: string;
  workerName: string;
  date: string;
  picksCompleted: number;
  picksPerHour: number;
  accuracy: number; // percentage 0-100
  distanceWalked: number; // meters
  tasksCompleted: number;
  avgTaskTime: number; // minutes
  uph: number; // units per hour
  // NEW: Breakdown by task type
  pickCount: number;
  packCount: number;
  receiveCount: number;
  putawayCount: number;
  // NEW: Quality metrics
  errors: number;
  returnsCaused: number;
  notes?: string;
}

// ─── NEW: Integration Endpoint ──────────────────────────────────────────
export interface IntegrationEndpoint {
  id?: number;
  name: string;
  type: 'erp' | 'oms' | 'tms' | 'wms' | 'marketplace' | 'carrier' | 'custom';
  provider: string;
  config: string; // JSON: {apiKey, endpoint, webhook, etc}
  status: 'active' | 'inactive' | 'error' | 'syncing';
  lastSync?: string;
  nextSync?: string;
  syncInterval: number; // minutes
  recordsSynced: number;
  errorCount: number;
  lastError?: string;
  createdAt: string;
}

// ─── NEW: Batch Group ───────────────────────────────────────────────────
export interface BatchGroup {
  id?: number;
  batchId: string;
  orderIds: string; // comma separated
  status: 'open' | 'picking' | 'packed' | 'shipped' | 'cancelled';
  pickerId?: string;
  packerId?: string;
  pickPath?: string; // JSON
  estimatedTime?: number;
  actualTime?: number;
  totalItems: number;
  totalWeight: number;
  createdAt: string;
  completedAt?: string;
  zoneProfile: string;
  pickingMethod: 'single' | 'batch' | 'zone' | 'wave';
}

// ─── NEW: Pick Path ─────────────────────────────────────────────────────
export interface PickPath {
  id?: number;
  pathId: string;
  orderIds: string; // comma separated
  route: string; // JSON: [{location, sku, qty, zone, distance}]
  totalDistance: number;
  estimatedTime: number;
  actualTime?: number;
  pickerId?: string;
  status: 'planned' | 'active' | 'completed' | 'cancelled';
  createdAt: string;
  completedAt?: string;
}

// ─── NEW: Box Size ──────────────────────────────────────────────────────
export interface BoxSize {
  id?: number;
  name: string;
  length: number;
  width: number;
  height: number;
  maxWeight: number;
  cost: number;
  material: string;
  active: boolean;
}

// ─── NEW v6: Serial Number ──────────────────────────────────────────────
export interface SerialNumber {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  serialNumber: string;
  sku: string;
  product: string;
  lotNumber?: string;
  batchNumber?: string;
  manufacturingDate?: string;
  expiryDate?: string;
  status: 'in_stock' | 'reserved' | 'shipped' | 'returned' | 'defective' | 'quarantine';
  location: string;
  orderId?: string;
  inboundId?: number;
  operator: string;
  createdAt: string;
  updatedAt: string;
  // Full traceability chain
  receivedAt?: string;
  shippedAt?: string;
  returnedAt?: string;
  inspectedAt?: string;
  // Warranty info
  warrantyStart?: string;
  warrantyEnd?: string;
  // Device-specific (for phones)
  imei1?: string;
  imei2?: string;
  tacPrefix?: string;
  color?: string;
  storage?: string;
}

// ─── NEW v6: Putaway Task ───────────────────────────────────────────────
export interface PutawayTask {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  taskId: string;
  sku: string;
  product: string;
  quantity: number;
  lotNumber?: string;
  expiryDate?: string;
  // Source
  sourceLocation: string;
  sourceType: 'receiving' | 'returns' | 'transfer' | 'qc_release' | 'cross_dock';
  inboundId?: number;
  poNumber?: string;
  // Destination
  suggestedLocation: string;
  actualLocation?: string;
  destinationZone: string;
  destinationAisle?: string;
  destinationRack?: string;
  destinationShelf?: string;
  // Status & assignment
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
  assignedTo?: string;
  priority: 'normal' | 'high' | 'urgent';
  // Timestamps
  createdAt: string;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  // Performance
  estimatedTime?: number; // minutes
  actualTime?: number; // minutes
  distance?: number; // meters
  // Quality
  qcStatus: 'pending' | 'passed' | 'failed' | 'released';
  putawayMethod: 'direct' | 'zone' | 'cross_dock' | 'consolidation';
  notes?: string;
  operator: string;
}

// ─── NEW v7: Dock Appointment ───────────────────────────────────────────
export interface DockAppointment {
  id?: number;
  // v10: tenancy scope — every operational row is bound to one site
  tenantCode?: string;
  warehouseCode?: string;
  appointmentId: string;
  supplier: string;
  poNumber?: string;
  dockNumber: string;
  scheduledDate: string;
  scheduledTime: string;
  estimatedDuration: number; // minutes
  status: 'scheduled' | 'checked_in' | 'unloading' | 'completed' | 'no_show' | 'cancelled';
  carrier?: string;
  trailerNumber?: string;
  palletCount?: number;
  asnNumber?: string;
  items?: string; // JSON
  notes?: string;
  operator: string;
  checkedInAt?: string;
  completedAt?: string;
  createdAt: string;
}

// ─── NEW v7: Inventory Reservation (re-exported from allocation) ────────
export interface InventoryReservation {
  id?: number;
  reservationId: string;
  // v10: exact bin/lot the reservation is pinned to (multi-bin FEFO accuracy)
  location?: string;
  stockStatus?: StockStatus;
  tenantCode?: string;
  warehouseCode?: string;
  expiryDate?: string | null;
  orderId: string;
  sku: string;
  quantity: number;
  lotNumber?: string;
  serialNumbers?: string;
  status: 'reserved' | 'allocated' | 'picked' | 'released' | 'expired';
  fefoPriority: number;
  reservedAt: string;
  expiresAt: string;
  operator: string;
  /** Why a promise ended (manual release vs. expiry) — keeps audits truthful. */
  note?: string;
  releasedAt?: string;
}

// ─── NEW v8: Google Sheets Ozon Sync ────────────────────────────────────
export interface SheetSyncConfig {
  id?: number;
  name: string;
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  sheetRange?: string;
  apiKey?: string;
  fetchMethod: 'gviz' | 'api' | 'auto' | 'upload';
  columnMapping?: string;
  autoSync: number;
  syncIntervalMinutes: number;
  autoAllocate: number;
  skipDuplicates: number;
  writeBackEnabled: number;
  lastSync?: string;
  lastRowCount?: number;
  lastError?: string;
  syncCount?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface SheetSyncLog {
  id?: number;
  configId: number;
  status: 'success' | 'partial' | 'error';
  message: string;
  recordsProcessed: number;
  totalRows: number;
  operator: string;
  deviceId: string;
  durationMs: number;
  createdAt: string;
}

export interface SheetSyncRow {
  id?: number;
  rowHash: string;
  orderId: string;
  sheetId: string;
  syncedAt: string;
  status: string;
}

export interface ConnectedDevice {
  id?: number;
  deviceId: string;
  deviceName: string;
  platform: string;
  userAgent: string;
  operator: string;
  lastSeen: string;
  isOnline: boolean;
  activeWorkflows: number;
  registeredAt: string;
}

// ─── v10: Multi-Dimensional Stock, Leased Outbox & Telemetry ───────────
export type StockStatus = 'AVAILABLE' | 'RESERVED' | 'QUARANTINE' | 'DAMAGED' | 'HOLD';

/**
 * One physical stock dimension row: tenant → warehouse → bin → SKU → lot →
 * stock status (→ optional serial). Balances are NEVER collapsed by SKU: two
 * bins holding the same SKU are two rows, and two warehouses are never mixed.
 */
export interface StockBalance {
  id?: number;
  tenantCode: string;
  warehouseCode: string;
  location: string;
  sku: string;
  lotNumber: string;
  stockStatus: StockStatus;
  serialNumber?: string;
  onHandQty: number;
  reservedQty: number;
  quarantineQty: number;
  expiryDate?: string | null;
  cloudId?: string | null;
  version: number;
  updatedAt: string;
}

export type OutboxStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_letter';

/**
 * One indexed outbox record per pending cloud command. Replaces the legacy
 * single-JSON `preferences` blob so multiple tabs can lease, retry and inspect
 * individual events, and so the DLQ is queryable.
 */
export interface OutboxEvent {
  id?: number;
  eventId: string;
  idempotencyKey: string;
  tenantCode: string;
  warehouseCode: string;
  command: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  nextRetryAt: number;
  leaseOwner?: string | null;
  leaseUntil?: number | null;
  lastError?: string | null;
  response?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface TelemetryEvent {
  id?: number;
  metric: string;
  value: number;
  unit: string;
  tenantCode: string;
  warehouseCode: string;
  deviceId?: string;
  labels?: Record<string, unknown>;
  ts: number;
  synced: 0 | 1;
}

/** Sellable units of one balance row (mirrors the SQL generated column). */
export function availableQty(b: Pick<StockBalance, 'onHandQty' | 'reservedQty' | 'quarantineQty'>): number {
  return Math.max(0, (b.onHandQty || 0) - (b.reservedQty || 0) - (b.quarantineQty || 0));
}

// ─── Database Class ────────────────────────────────────────────────────
class VortexDB extends Dexie {
  inventory!: Table<InventoryItem>;
  orders!: Table<Order>;
  returns!: Table<ReturnRecord>;
  inbound!: Table<InboundRecord>;
  auditLogs!: Table<AuditLog>;
  users!: Table<User>;
  inventoryMovements!: Table<InventoryMovement>;
  cycleCounts!: Table<CycleCount>;
  zoneCapacities!: Table<ZoneCapacity>;
  workerTasks!: Table<WorkerTask>;
  replenishmentTasks!: Table<ReplenishmentTask>;
  qcHolds!: Table<QCHold>;
  waveBatches!: Table<WaveBatch>;
  templates!: Table<Template>;
  aliases!: Table<Alias>;
  preferences!: Table<Preference>;
  simDb!: Table<SimDbEntry>;
  postingRecords!: Table<PostingRecord>;
  // v5 tables
  purchaseOrders!: Table<PurchaseOrder>;
  shippingLabels!: Table<ShippingLabel>;
  carrierRates!: Table<CarrierRate>;
  workerPerformance!: Table<WorkerPerformance>;
  integrationEndpoints!: Table<IntegrationEndpoint>;
  batchGroups!: Table<BatchGroup>;
  pickPaths!: Table<PickPath>;
  boxSizes!: Table<BoxSize>;
  // v6 tables
  serialNumbers!: Table<SerialNumber>;
  putawayTasks!: Table<PutawayTask>;
  // v7 tables
  dockAppointments!: Table<DockAppointment>;
  inventoryReservations!: Table<InventoryReservation>;
  // v8 tables
  sheetSyncConfigs!: Table<SheetSyncConfig>;
  sheetSyncLogs!: Table<SheetSyncLog>;
  sheetSyncRows!: Table<SheetSyncRow>;
  connectedDevices!: Table<ConnectedDevice>;
  quickNotes!: Table<QuickNote>;
  gSheetEntries!: Table<GSheetEntry>;
  // v10 tables
  stockBalances!: Table<StockBalance>;
  outboxEvents!: Table<OutboxEvent>;
  telemetryEvents!: Table<TelemetryEvent>;

  constructor() {
    super('VortexWMS');
    this.version(7).stores({
      inventory: '++id, sku, location, category, velocity, barcode, rfidTag, lotNumber, batchNumber, expiryDate',
      orders: '++id, orderId, status, priority, waveId, assignedTo, batchId, carrier',
      returns: '++id, orderId, sku',
      inbound: '++id, sku, receivedAt, crossDockOrderId, qcStatus, poNumber, supplier',
      auditLogs: '++id, timestamp',
      users: '++id, username, currentZone',
      inventoryMovements: '++id, sku, type, timestamp, orderId, operator',
      cycleCounts: '++id, sku, location, status, abcClass, nextScheduled',
      zoneCapacities: '++id, zone, category, velocityTarget, binType',
      workerTasks: '++id, type, status, assignedTo, priority, createdAt, orderId',
      replenishmentTasks: '++id, sku, status',
      qcHolds: '++id, sku, status',
      waveBatches: '++id, waveId, status',
      templates: '++id, raw',
      aliases: '++id, source',
      preferences: '++id, key',
      simDb: '++id, tacPrefix',
      postingRecords: '++id, postingId, status, createdAt, folder',
      // v5 indexes
      purchaseOrders: '++id, poNumber, supplier, status, expectedDelivery',
      shippingLabels: '++id, orderId, carrier, trackingNumber, status',
      carrierRates: '++id, carrier, service, weightFrom, weightTo, zone, active',
      workerPerformance: '++id, workerId, date, uph',
      integrationEndpoints: '++id, name, type, status, lastSync',
      batchGroups: '++id, batchId, status, pickerId, pickingMethod',
      pickPaths: '++id, pathId, status, pickerId',
      boxSizes: '++id, name, active',
      // v6 indexes
      serialNumbers: '++id, serialNumber, sku, status, location, orderId',
      putawayTasks: '++id, taskId, sku, status, assignedTo, destinationZone, sourceType',
      // v7 indexes
      dockAppointments: '++id, appointmentId, supplier, dockNumber, status, scheduledDate',
      inventoryReservations: '++id, reservationId, orderId, sku, status, reservedAt',
    });
    this.version(8).stores({
      inventory: '++id, sku, location, category, velocity, barcode, rfidTag, lotNumber, batchNumber, expiryDate',
      orders: '++id, orderId, status, priority, waveId, assignedTo, batchId, carrier',
      returns: '++id, orderId, sku',
      inbound: '++id, sku, receivedAt, crossDockOrderId, qcStatus, poNumber, supplier',
      auditLogs: '++id, timestamp',
      users: '++id, username, currentZone',
      inventoryMovements: '++id, sku, type, timestamp, orderId, operator',
      cycleCounts: '++id, sku, location, status, abcClass, nextScheduled',
      zoneCapacities: '++id, zone, category, velocityTarget, binType',
      workerTasks: '++id, type, status, assignedTo, priority, createdAt, orderId',
      replenishmentTasks: '++id, sku, status',
      qcHolds: '++id, sku, status',
      waveBatches: '++id, waveId, status',
      templates: '++id, raw',
      aliases: '++id, source',
      preferences: '++id, key',
      simDb: '++id, tacPrefix',
      postingRecords: '++id, postingId, status, createdAt, folder',
      purchaseOrders: '++id, poNumber, supplier, status, expectedDelivery',
      shippingLabels: '++id, orderId, carrier, trackingNumber, status',
      carrierRates: '++id, carrier, service, weightFrom, weightTo, zone, active',
      workerPerformance: '++id, workerId, date, uph',
      integrationEndpoints: '++id, name, type, status, lastSync',
      batchGroups: '++id, batchId, status, pickerId, pickingMethod',
      pickPaths: '++id, pathId, status, pickerId',
      boxSizes: '++id, name, active',
      serialNumbers: '++id, serialNumber, sku, status, location, orderId',
      putawayTasks: '++id, taskId, sku, status, assignedTo, destinationZone, sourceType',
      dockAppointments: '++id, appointmentId, supplier, dockNumber, status, scheduledDate',
      inventoryReservations: '++id, reservationId, orderId, sku, status, reservedAt',
      sheetSyncConfigs: '++id, spreadsheetId, autoSync, lastSync, name',
      sheetSyncLogs: '++id, configId, status, createdAt, deviceId',
      sheetSyncRows: '++id, rowHash, orderId, sheetId, syncedAt',
      connectedDevices: '++id, deviceId, operator, lastSeen',
      quickNotes: '++id, createdAt, pinned',
    });

    this.version(9).stores({
      gSheetEntries: '++id, name, day, updatedAt',
    });

    // v10 — multi-dimensional stock, leased outbox, telemetry, and strict
    // (tenant, warehouse) scoping indexes on every operational table so a
    // warehouse switch can never read or write another warehouse's rows.
    this.version(10).stores({
      stockBalances:
        '++id, &[tenantCode+warehouseCode+location+sku+lotNumber+stockStatus], [tenantCode+warehouseCode], [tenantCode+warehouseCode+sku], [tenantCode+warehouseCode+location], [tenantCode+warehouseCode+stockStatus], sku, location, expiryDate, updatedAt',
      outboxEvents:
        '++id, &eventId, &idempotencyKey, [tenantCode+warehouseCode+status], status, nextRetryAt, leaseUntil, command, createdAt',
      telemetryEvents: '++id, metric, [tenantCode+warehouseCode], synced, ts',
      inventory:
        '++id, sku, location, category, velocity, barcode, rfidTag, lotNumber, batchNumber, expiryDate, tenantCode, warehouseCode, [tenantCode+warehouseCode], [tenantCode+warehouseCode+sku], [warehouseCode+sku], updatedAt',
      orders:
        '++id, orderId, status, priority, waveId, assignedTo, batchId, carrier, tenantCode, warehouseCode, shippedAt, updatedAt, [tenantCode+warehouseCode], [tenantCode+warehouseCode+status], [warehouseCode+status]',
      inventoryMovements:
        '++id, sku, type, timestamp, orderId, operator, tenantCode, warehouseCode, [tenantCode+warehouseCode], [warehouseCode+sku]',
      inventoryReservations:
        '++id, reservationId, orderId, sku, status, reservedAt, tenantCode, warehouseCode, [tenantCode+warehouseCode], [warehouseCode+sku]',
      putawayTasks:
        '++id, taskId, sku, status, assignedTo, destinationZone, sourceType, tenantCode, warehouseCode, [tenantCode+warehouseCode]',
      qcHolds: '++id, sku, status, tenantCode, warehouseCode, [tenantCode+warehouseCode]',
      inbound: '++id, sku, receivedAt, crossDockOrderId, qcStatus, poNumber, supplier, tenantCode, warehouseCode, [tenantCode+warehouseCode]',
      returns: '++id, orderId, sku, tenantCode, warehouseCode, [tenantCode+warehouseCode]',
      auditLogs: '++id, timestamp, action, operator',
    });
  }
}

export const db = new VortexDB();

// Audit log helper (writes locally + queues cloud audit trail)
export async function logAction(action: string, details: string, operator: string) {
  try {
    await db.auditLogs.add({
      action,
      details,
      operator,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // IndexedDB unavailable in restricted iframe — still attempt cloud audit queue
  }
  void enqueueCloudOperation('audit_log', { action, details, operator }).catch(() => {});
}

/** Normalize template raw key for matching */
export function normalizeTemplateRaw(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Upsert a single template by case-insensitive exact `raw` match.
 * Returns 'added' | 'updated'.
 */
export async function upsertTemplate(raw: string, standard: string): Promise<'added' | 'updated'> {
  const cleanRaw = normalizeTemplateRaw(raw);
  const cleanStd = standard.trim();
  if (!cleanRaw || !cleanStd) throw new Error('Template raw and standard are required');

  const existing = await db.templates.where('raw').equals(cleanRaw).first();
  if (existing?.id != null) {
    await db.templates.update(existing.id, {
      standard: cleanStd,
      createdAt: new Date().toISOString(),
    });
    return 'updated';
  }

  // Case-insensitive fallback (Dexie equals is case-sensitive)
  const all = await db.templates.toArray();
  const hit = all.find((t) => normalizeTemplateRaw(t.raw).toUpperCase() === cleanRaw.toUpperCase());
  if (hit?.id != null) {
    await db.templates.update(hit.id, {
      raw: cleanRaw,
      standard: cleanStd,
      createdAt: new Date().toISOString(),
    });
    return 'updated';
  }

  await db.templates.add({
    raw: cleanRaw,
    standard: cleanStd,
    createdAt: new Date().toISOString(),
  });
  return 'added';
}

/** Bulk upsert template pairs; de-dupes by normalized raw within the batch. */
export async function upsertTemplatesBulk(
  pairs: { raw: string; standard: string }[]
): Promise<{ added: number; updated: number; skipped: number }> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = normalizeTemplateRaw(pair.raw).toUpperCase();
    if (!key || !pair.standard.trim()) {
      skipped++;
      continue;
    }
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const result = await upsertTemplate(pair.raw, pair.standard);
    if (result === 'added') added++;
    else updated++;
  }
  return { added, updated, skipped };
}



// Inventory movement logger (writes local movement + ACID cloud inventory ledger)
export async function logInventoryMovement(
  sku: string,
  type: InventoryMovement['type'],
  quantity: number,
  operator: string,
  opts?: { fromLocation?: string; toLocation?: string; orderId?: string; lotNumber?: string; note?: string }
) {
  await db.inventoryMovements.add({
    sku,
    type,
    quantity,
    operator,
    fromLocation: opts?.fromLocation,
    toLocation: opts?.toLocation,
    orderId: opts?.orderId,
    lotNumber: opts?.lotNumber,
    note: opts?.note,
    timestamp: new Date().toISOString(),
  });

  const negativeTypes = new Set(['outbound', 'pick', 'pack']);
  const qtyDelta = negativeTypes.has(type) ? -Math.abs(quantity) : Math.abs(quantity);
  const location = opts?.toLocation || opts?.fromLocation || 'PHONE-A-01';
  const mappedTx = type === 'qc_adjustment' ? 'qc_release' : type;

  void enqueueCloudOperation('stock_movement', {
    sku,
    qtyDelta,
    transactionType: mappedTx,
    location,
    lotNumber: opts?.lotNumber || 'DEFAULT',
    referenceType: opts?.orderId ? 'ORDER' : 'MANUAL',
    referenceId: opts?.orderId || null,
    operator,
    note: opts?.note || null,
  }).catch(() => {});
}

// Export all data as JSON
export async function exportAllData() {
  const inventory = await db.inventory.toArray();
  const orders = await db.orders.toArray();
  const returns = await db.returns.toArray();
  const inbound = await db.inbound.toArray();
  const auditLogs = await db.auditLogs.toArray();
  const inventoryMovements = await db.inventoryMovements.toArray();
  const cycleCounts = await db.cycleCounts.toArray();
  const zoneCapacities = await db.zoneCapacities.toArray();
  const workerTasks = await db.workerTasks.toArray();
  const replenishmentTasks = await db.replenishmentTasks.toArray();
  const qcHolds = await db.qcHolds.toArray();
  const waveBatches = await db.waveBatches.toArray();
  const templates = await db.templates.toArray();
  const aliases = await db.aliases.toArray();
  const preferences = await db.preferences.toArray();
  const simDb = await db.simDb.toArray();
  const postingRecords = await db.postingRecords.toArray();
  const purchaseOrders = await db.purchaseOrders.toArray();
  const shippingLabels = await db.shippingLabels.toArray();
  const carrierRates = await db.carrierRates.toArray();
  const workerPerformance = await db.workerPerformance.toArray();
  const integrationEndpoints = await db.integrationEndpoints.toArray();
  const batchGroups = await db.batchGroups.toArray();
  const pickPaths = await db.pickPaths.toArray();
  const boxSizes = await db.boxSizes.toArray();
  const serialNumbers = await db.serialNumbers.toArray();
  const putawayTasks = await db.putawayTasks.toArray();
  const dockAppointments = await db.dockAppointments.toArray();
  const inventoryReservations = await db.inventoryReservations.toArray();
  const sheetSyncConfigs = await db.sheetSyncConfigs.toArray();
  const sheetSyncLogs = await db.sheetSyncLogs.toArray();
  const sheetSyncRows = await db.sheetSyncRows.toArray();
  const connectedDevices = await db.connectedDevices.toArray();
  return {
    inventory, orders, returns, inbound, auditLogs,
    inventoryMovements, cycleCounts, zoneCapacities,
    workerTasks, replenishmentTasks, qcHolds, waveBatches,
    templates, aliases, preferences, simDb, postingRecords,
    purchaseOrders, shippingLabels, carrierRates, workerPerformance,
    integrationEndpoints, batchGroups, pickPaths, boxSizes,
    serialNumbers, putawayTasks, dockAppointments, inventoryReservations,
    sheetSyncConfigs, sheetSyncLogs, sheetSyncRows, connectedDevices,
    exportDate: new Date().toISOString(),
  };
}

// ─── Seeding & First-Run Bootstrap ─────────────────────────────────────
/**
 * Demo seeding is a DEVELOPMENT affordance only.
 *
 * A production build (`import.meta.env.PROD`) never creates the legacy
 * `admin`/`VINOVJ`/`operator`/`supervisor` accounts and never fabricates demo
 * stock or marketplace orders, unless the operator explicitly opts in with
 * `VITE_WMS_ENABLE_DEMO_SEED=true`. First-run access is granted through
 * `bootstrapInitialAdmin()` (local edge mode) or the audited server-side
 * `wms_bootstrap_first_admin` RPC (cloud mode).
 */
export const DEMO_SEED_ENABLED: boolean =
  !import.meta.env.PROD || String(import.meta.env.VITE_WMS_ENABLE_DEMO_SEED ?? '').toLowerCase() === 'true';

/** Reference/config data the floor UI needs even on an empty production install. */
export async function seedReferenceData(): Promise<void> {
  const zoneCount = await db.zoneCapacities.count();
  if (zoneCount === 0) {
    await db.zoneCapacities.bulkAdd([
      { zone: "PHONE-A", maxCapacity: 400, currentUtilization: 0, category: "Phones", velocityTarget: "high", aisle: "A", rack: "01", shelf: "01", binType: "shelf" },
      { zone: "WEAR-B", maxCapacity: 200, currentUtilization: 0, category: "Wearables", velocityTarget: "high", aisle: "B", rack: "01", shelf: "01", binType: "shelf" },
      { zone: "AUDIO-C", maxCapacity: 150, currentUtilization: 0, category: "Audio", velocityTarget: "medium", aisle: "C", rack: "01", shelf: "01", binType: "shelf" },
      { zone: "WAVE", maxCapacity: 80, currentUtilization: 0, category: "Staging", velocityTarget: "high", aisle: "PACK", rack: "00", shelf: "00", binType: "floor" },
    ]);
  }

  const boxCount = await db.boxSizes.count();
  if (boxCount === 0) {
    await db.boxSizes.bulkAdd([
      { name: "Phone S", length: 18, width: 10, height: 4, maxWeight: 0.5, cost: 0.35, material: "corrugated", active: true },
      { name: "Phone M", length: 20, width: 12, height: 5, maxWeight: 0.7, cost: 0.45, material: "corrugated", active: true },
      { name: "Watch", length: 14, width: 12, height: 8, maxWeight: 0.4, cost: 0.4, material: "corrugated", active: true },
      { name: "Audio", length: 12, width: 10, height: 6, maxWeight: 0.3, cost: 0.3, material: "corrugated", active: true },
    ]);
  }

  const rateCount = await db.carrierRates.count();
  if (rateCount === 0) {
    await db.carrierRates.bulkAdd([
      { carrier: "GBS Express", service: "Ozon Global", weightFrom: 0, weightTo: 0.5, zone: "RU", rate: 8.5, currency: "USD", estimatedDays: 12, active: true },
      { carrier: "GBS Express", service: "Ozon Global", weightFrom: 0.5, weightTo: 2, zone: "RU", rate: 12, currency: "USD", estimatedDays: 12, active: true },
    ]);
  }
}

/** True when the local edge database has no operator account yet. */
export async function requiresBootstrap(): Promise<boolean> {
  try {
    return (await db.users.count()) === 0;
  } catch {
    return false;
  }
}

export interface BootstrapInput {
  username: string;
  password: string;
  displayName?: string;
  role?: User['role'];
  tenantCode?: string;
  warehouseCode?: string;
}

export type BootstrapResult =
  | { ok: true; username: string; role: User['role'] }
  | { ok: false; code: string; error: string };

/** Client-side mirror of the server password policy (migration 008). */
export function validatePasswordStrength(password: string, username: string): { ok: true } | { ok: false; code: string; error: string } {
  const pwd = password ?? '';
  if (pwd.length < 10) return { ok: false, code: 'PASSWORD_TOO_SHORT', error: 'Password must be at least 10 characters' };
  if (pwd.length > 128) return { ok: false, code: 'PASSWORD_TOO_LONG', error: 'Password must be at most 128 characters' };
  let classes = 0;
  if (/[a-z]/.test(pwd)) classes++;
  if (/[A-Z]/.test(pwd)) classes++;
  if (/[0-9]/.test(pwd)) classes++;
  if (/[^A-Za-z0-9]/.test(pwd)) classes++;
  if (classes < 3) {
    return { ok: false, code: 'PASSWORD_TOO_SIMPLE', error: 'Combine at least 3 of: lowercase, uppercase, digit, symbol' };
  }
  if (username && pwd.toLowerCase() === username.trim().toLowerCase()) {
    return { ok: false, code: 'PASSWORD_EQUALS_USERNAME', error: 'Password must not equal the username' };
  }
  const common = ['password', 'password123', 'qwertyuiop', '1234567890', 'adminadmin', 'changeme123'];
  if (common.includes(pwd.toLowerCase())) return { ok: false, code: 'PASSWORD_COMMON', error: 'Password is too common' };
  return { ok: true };
}

/**
 * One-time first administrator bootstrap for Offline-Edge mode.
 * Refuses to run once any operator account exists, and never accepts a
 * password equal to the username or shorter than the policy minimum.
 */
export async function bootstrapInitialAdmin(input: BootstrapInput): Promise<BootstrapResult> {
  const username = (input.username ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return { ok: false, code: 'INVALID_USERNAME', error: 'Username must be 3-32 characters (letters, digits, dot, dash, underscore)' };
  }
  const strength = validatePasswordStrength(input.password ?? '', username);
  if (!strength.ok) return strength;

  try {
    if ((await db.users.count()) > 0) {
      return {
        ok: false,
        code: 'BOOTSTRAP_ALREADY_COMPLETED',
        error: 'Bootstrap is closed: this installation already has operator accounts.',
      };
    }
    const now = new Date().toISOString();
    const role = input.role ?? 'admin';
    await db.users.add({
      username,
      password: await hashPasswordLocal(input.password),
      role,
      displayName: (input.displayName ?? '').trim() || username,
      createdAt: now,
      skillLevel: role === 'admin' ? 5 : 3,
      tenantCode: input.tenantCode ?? DEFAULT_TENANT_CODE,
      warehouseCode: input.warehouseCode ?? DEFAULT_WAREHOUSE_CODE,
      mustChangePassword: false,
    } as User);
    await db.auditLogs.add({
      action: 'ADMIN_BOOTSTRAPPED',
      details: `First-run administrator bootstrap completed for ${username}`,
      operator: username,
      timestamp: now,
    });
    await db.preferences.put({ key: 'wms_bootstrap_completed_at', value: now, createdAt: now } as Preference);
    return { ok: true, username, role };
  } catch (err) {
    return { ok: false, code: 'BOOTSTRAP_FAILED', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Rotate a local operator credential (also clears a forced-rotation flag). */
export async function rotateLocalPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const user = await db.users.where('username').equalsIgnoreCase(username.trim()).first();
  if (!user || user.id == null) return { ok: false, code: 'USER_NOT_FOUND', error: 'Operator not found' };
  if (!(await verifyPasswordLocal(currentPassword, user.password))) {
    return { ok: false, code: 'CURRENT_PASSWORD_INVALID', error: 'Current password is incorrect' };
  }
  const strength = validatePasswordStrength(newPassword, user.username);
  if (!strength.ok) return strength;
  await db.users.update(user.id, {
    password: await hashPasswordLocal(newPassword),
    mustChangePassword: false,
  });
  await logAction('PASSWORD_ROTATED', `Local credential rotated for ${user.username}`, user.username);
  return { ok: true };
}

/**
 * Demo dataset (development only): legacy Ozon wave SKUs, postings and orders.
 * Guarded by `DEMO_SEED_ENABLED`; production builds call `seedReferenceData()`.
 */
export async function seedDemoWaveData(): Promise<void> {
  const now = new Date().toISOString();
  const invCount = await db.inventory.count();
  if (invCount > 0) return;

  const wave = waveData;
  const locationFor = (product: string) => {
    const p = product.toLowerCase();
    if (p.includes("наушник") || p.includes("buds")) return "AUDIO-C-01";
    if (p.includes("час") || p.includes("watch")) return "WEAR-B-01";
    return "PHONE-A-01";
  };
  const categoryFor = (product: string) => {
    const p = product.toLowerCase();
    if (p.includes("наушник") || p.includes("buds")) return "Audio";
    if (p.includes("час") || p.includes("watch")) return "Wearables";
    return "Phones";
  };

  await db.inventory.bulkAdd(
    wave.skus.map((s) => ({
      sku: s.article || s.sku,
      barcode: s.sku,
      product: s.product,
      stock: Math.max(8, Math.round(s.qty) * 3),
      location: locationFor(s.product),
      category: categoryFor(s.product),
      velocity: s.qty >= 7 ? "high" : s.qty >= 3 ? "medium" : "low",
      costPerUnit: s.price,
      serializable: true,
      reorderPoint: 4,
      reorderQty: 10,
      tenantCode: DEFAULT_TENANT_CODE,
      warehouseCode: DEFAULT_WAREHOUSE_CODE,
      updatedAt: now,
    })),
  );

  await db.orders.bulkAdd(
    wave.postings.map((p) => ({
      orderId: p.postingId,
      status: "Pending" as const,
      requiredSkus: p.article || p.sku,
      priority: p.amount >= 500 ? "high" : "normal",
      createdAt: p.acceptedAt || now,
      updatedAt: now,
      carrier: "GBS Express",
      service: "Ozon Global",
      trackingNumber: p.postingId,
      shippingCost: 0,
      weightTotal: 0.4,
      tenantCode: DEFAULT_TENANT_CODE,
      warehouseCode: DEFAULT_WAREHOUSE_CODE,
    })),
  );

  await db.postingRecords.bulkAdd(
    wave.postings.map((p) => ({
      postingId: p.postingId,
      trackingId: p.postingId,
      orderId: p.orderId,
      status: "received" as const,
      carrier: "Ozon / GBS Express",
      city: "Sharjah",
      note: p.product,
      operator: "System",
      createdAt: p.acceptedAt || now,
      folder: "wave-31-may",
    })),
  );

  await db.auditLogs.add({
    action: "SEED",
    details: `Loaded demo Ozon wave: ${wave.postings.length} postings, ${wave.skus.length} SKUs (development mode)`,
    operator: "System",
    timestamp: now,
  });
}

/**
 * Boot-time seeding entry point.
 *
 * - Always: migrate legacy plaintext local passwords to PBKDF2-SHA256 and load
 *   operational reference data.
 * - Development / explicit opt-in only: demo accounts + demo wave data.
 */
export async function seedDatabase(): Promise<{ demoSeeded: boolean; users: number }> {
  const now = new Date().toISOString();

  // Legacy plaintext -> PBKDF2-SHA256 migration (never seeds credentials itself)
  try {
    const existingUsers = await db.users.toArray();
    for (const u of existingUsers) {
      if (u.id != null && !isHashedSecret(u.password)) {
        await db.users.update(u.id, { password: await hashPasswordLocal(u.password) });
      }
    }
  } catch {
    // IndexedDB may be unavailable inside a restricted iframe
  }

  await seedReferenceData();

  if (!DEMO_SEED_ENABLED) {
    await db.auditLogs
      .add({
        action: "SEED_SKIPPED",
        details: "Production build: demo operator accounts and demo stock were not seeded",
        operator: "System",
        timestamp: now,
      })
      .catch(() => {});
    return { demoSeeded: false, users: await db.users.count().catch(() => 0) };
  }

  const usersCount = await db.users.count();
  if (usersCount === 0) {
    const [adminHash, vinoHash, opHash, supHash] = await Promise.all([
      hashPasswordLocal('admin-demo-2026'),
      hashPasswordLocal('vinovj-demo-2026'),
      hashPasswordLocal('operator-demo-2026'),
      hashPasswordLocal('supervisor-demo-2026'),
    ]);
    await db.users.bulkAdd([
      { username: 'admin', password: adminHash, role: 'admin', displayName: 'Administrator', createdAt: now, skillLevel: 5, mustChangePassword: true },
      { username: 'VINOVJ', password: vinoHash, role: 'admin', displayName: 'Vino VJ', createdAt: now, skillLevel: 5, mustChangePassword: true },
      { username: 'operator', password: opHash, role: 'operator', displayName: 'Floor Operator', createdAt: now, skillLevel: 3, mustChangePassword: true },
      { username: 'supervisor', password: supHash, role: 'supervisor', displayName: 'Shift Supervisor', createdAt: now, skillLevel: 4, mustChangePassword: true },
    ] as User[]);
  }

  await seedDemoWaveData();
  return { demoSeeded: true, users: await db.users.count() };
}
