import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach, mock } from 'node:test';
import { normalizePaymentRecord } from '../src/store.js';

const lease = {
  id: 'lease-101',
  tenantId: 'tenant-101',
  unitId: 'unit-101',
  propertyId: 'property-1',
  unitNumber: 101,
  status: 'Active',
};
const unit = {
  id: 'unit-101',
  propertyId: 'property-1',
  unitNumber: 101,
};
const tenant = {
  id: 'tenant-101',
  name: 'Tenant One',
  email: 'private@example.test',
};

const tables = { payment_notifications: [] };
let nextNotificationId = 1;
let leases = [lease];
let units = [unit];
let tenants = [tenant];
let rpcResponse = { data: { success: true }, error: null };
let rpcCalls = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.payload = null;
    this.selectedFields = '*';
  }

  select(fields = '*') { this.selectedFields = fields; return this; }
  insert(payload) { this.action = 'insert'; this.payload = payload; return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  order() { return this; }

  async execute(single = false) {
    const rows = tables[this.table];
    const project = (row) => {
      if (!row || this.selectedFields === '*') return row;
      return Object.fromEntries(
        this.selectedFields.split(',').map((field) => field.trim())
          .filter((field) => Object.hasOwn(row, field))
          .map((field) => [field, row[field]])
      );
    };
    if (this.action === 'insert') {
      const duplicate = rows.find((row) =>
        row.lease_id === this.payload.lease_id &&
        row.idempotency_key === this.payload.idempotency_key
      );
      if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      const saved = {
        id: `notification-${nextNotificationId++}`,
        status: 'Pending Verification',
        submitted_at: new Date().toISOString(),
        ...this.payload,
      };
      rows.push(saved);
      return { data: project(saved), error: null };
    }

    const selected = rows.filter((row) =>
      this.filters.every(([key, value]) => String(row[key]) === String(value))
    );
    const projected = selected.map(project);
    return { data: single ? projected[0] ?? null : projected, error: null };
  }

  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

const fakeSupabase = {
  from(table) { return new FakeQuery(table); },
  async rpc(name, params) {
    rpcCalls.push({ name, params });
    return rpcResponse;
  },
};

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: { supabaseServiceRole: fakeSupabase },
});
mock.module(new URL('../src/dataService.js', import.meta.url).href, {
  exports: {
    getLeases: async () => leases,
    getUnits: async () => units,
    getTenants: async () => tenants,
  },
});

const {
  listManagerPaymentNotifications,
  reviewPaymentNotification,
  submitTenantPaymentNotification,
} = await import('../src/paymentNotifications.js');

const request = (overrides = {}) => ({
  access: { leaseId: lease.id, tenantId: tenant.id, unitNumber: 101 },
  requestedUnitNumber: '101',
  body: {
    amount: '125.50',
    paymentMethod: 'Bank Transfer',
    transactionReference: 'transfer-abc',
  },
  idempotencyKey: '123e4567-e89b-12d3-a456-426614174000',
  ...overrides,
});

beforeEach(() => {
  tables.payment_notifications.length = 0;
  nextNotificationId = 1;
  leases = [lease];
  units = [unit];
  tenants = [tenant];
  rpcResponse = { data: { success: true }, error: null };
  rpcCalls = [];
});

test('tenant notification saves trusted lease data and submitted payment details', async () => {
  const result = await submitTenantPaymentNotification(request({
    body: { ...request().body, tenantName: 'Untrusted Name' },
  }));

  assert.equal(result.status, 201);
  assert.equal(result.body.notification.amount, 125.5);
  assert.equal(tables.payment_notifications[0].lease_id, lease.id);
  assert.equal(tables.payment_notifications[0].tenant_id, tenant.id);
  assert.equal(tables.payment_notifications[0].unit_id, unit.id);
  assert.equal(tables.payment_notifications[0].transaction_reference, 'transfer-abc');
  assert.equal('tenant_name' in tables.payment_notifications[0], false);
});

test('notification submission rejects missing tenant sessions', async () => {
  const result = await submitTenantPaymentNotification(request({ access: null }));
  assert.equal(result.status, 401);
});

test('notification cannot use a different tenant or ambiguous unit-to-lease mapping', async () => {
  const mismatch = await submitTenantPaymentNotification(request({
    access: { leaseId: lease.id, tenantId: 'other-tenant', unitNumber: 101 },
  }));
  assert.equal(mismatch.status, 403);

  leases = [{ ...lease, unitId: null }];
  units = [unit, { ...unit, id: 'unit-101-duplicate' }];
  const ambiguous = await submitTenantPaymentNotification(request());
  assert.equal(ambiguous.status, 404);
  assert.equal(tables.payment_notifications.length, 0);
});

test('same idempotency key replays the existing notification; a new key permits a later submission', async () => {
  const first = await submitTenantPaymentNotification(request());
  const retry = await submitTenantPaymentNotification(request());
  const keyReuse = await submitTenantPaymentNotification(request({
    body: { ...request().body, amount: '200.00' },
  }));
  const later = await submitTenantPaymentNotification(request({
    idempotencyKey: '123e4567-e89b-12d3-a456-426614174001',
  }));

  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.notification.id, first.body.notification.id);
  assert.equal(keyReuse.status, 409);
  assert.equal(later.status, 201);
  assert.equal(tables.payment_notifications.length, 2);
});

test('concurrent same-key submissions persist one row and return the same notification', async () => {
  const [first, retry] = await Promise.all([
    submitTenantPaymentNotification(request()),
    submitTenantPaymentNotification(request()),
  ]);

  assert.deepEqual([first.status, retry.status].sort(), [200, 201]);
  assert.equal(first.body.notification.id, retry.body.notification.id);
  assert.equal(tables.payment_notifications.length, 1);
});

test('manager list joins tenant names only through the matching lease relationship', async () => {
  tables.payment_notifications.push(
    { id: 'valid', lease_id: lease.id, tenant_id: tenant.id },
    { id: 'mismatch', lease_id: lease.id, tenant_id: 'other-tenant' },
  );

  const notifications = await listManagerPaymentNotifications();
  assert.equal(notifications.find((item) => item.id === 'valid').tenant_name, 'Tenant One');
  assert.equal(notifications.find((item) => item.id === 'mismatch').tenant_name, null);
  assert.equal('email' in notifications.find((item) => item.id === 'valid'), false);
});

test('manager review actions call the atomic review RPC', async () => {
  const actions = [
    ['notification-1', 'VerifiedManual'],
    ['notification-2', 'VerifiedAuto'],
    ['notification-3', 'MarkManuallyRecorded'],
    ['notification-4', 'Rejected'],
  ];

  for (const [notificationId, action] of actions) {
    const result = await reviewPaymentNotification({
      notificationId,
      action,
      reviewNote: 'Reviewed by manager',
      reviewedBy: 'manager-1',
    });
    assert.equal(result.status, 200, action + ' should succeed');
  }

  assert.deepEqual(
    rpcCalls.map((call) => call.params.p_action),
    ['VerifiedManual', 'VerifiedAuto', 'MarkManuallyRecorded', 'Rejected']
  );
  assert.equal(rpcCalls[0].params.p_reviewed_by, 'manager-1');

  rpcResponse = {
    data: null,
    error: { message: 'This notification has already been reviewed.' },
  };

  const duplicateReview = await reviewPaymentNotification({
    notificationId: 'notification-5',
    action: 'VerifiedManual',
    reviewNote: '',
    reviewedBy: 'manager-1',
  });

  assert.equal(duplicateReview.status, 409);
});

test('new review-mode migration separates manual and automatic rent recording', () => {
  const migration = readFileSync(
    new URL('../migrations/20261021_payment_notification_review_modes.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /'VerifiedManual'/i);
  assert.match(migration, /'VerifiedAuto'/i);
  assert.match(migration, /'MarkManuallyRecorded'/i);
  assert.match(migration, /'Verified - Awaiting Rent Recording'/i);
  assert.match(migration, /'Verified - Rent Recorded'/i);
  assert.match(migration, /p_action = 'MarkManuallyRecorded'[\s\S]*?UPDATE public\.payment_notifications[\s\S]*?RETURN jsonb_build_object/i);
  assert.match(migration, /p\.lease_id::text = v_notification\.lease_id/i);
  assert.match(migration, /p\.tenant_id::text = v_notification\.tenant_id/i);
  assert.match(migration, /IF v_remaining > 0 THEN[\s\S]*?RAISE EXCEPTION/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.review_payment_notification/i);
});

test('review migration preserves exact lease matching and balance protections', () => {
  const migration = readFileSync(
    new URL('../migrations/20261018_payment_notifications_review_fields.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /WHERE id = p_notification_id\s+FOR UPDATE/i);
  assert.match(migration, /v_notification\.status <> 'Pending Verification'/i);
  assert.match(migration, /p\.lease_id IS NOT NULL/i);
  assert.match(migration, /p\.lease_id::text = v_notification\.lease_id/i);
  assert.match(migration, /COALESCE\(p\.paid_amount, 0\) < p\.amount/i);
  assert.doesNotMatch(migration, /INSERT INTO public\.payments/i);
  assert.doesNotMatch(migration, /UPDATE public\.payments[\s\S]*?SET\s+lease_id/i);
});

test('full and partial notification allocations mark only the allocated amount verified', () => {
  const migration = readFileSync(
    new URL('../migrations/20261018_payment_notifications_review_fields.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /v_apply := LEAST\(v_remaining, v_due\)/i);
  assert.match(migration, /v_paid := ROUND\(COALESCE\(v_payment\.paid_amount, 0\) \+ v_apply, 2\)/i);
  assert.match(migration, /IF v_paid >= v_payment\.amount THEN\s+v_status := 'Paid';\s+ELSIF v_paid > 0 THEN\s+v_status := 'Partially Paid';/i);
  assert.match(migration, /SET paid_amount = v_paid,[\s\S]*?status = v_status,[\s\S]*?verification_status = 'Verified',[\s\S]*?verified_at = now\(\),[\s\S]*?verified_by = p_reviewed_by/i);
  assert.match(migration, /IF v_remaining > 0 THEN\s+RAISE EXCEPTION\s+'Insufficient outstanding rent balance/i);
});

test('rejection leaves rent rows unchanged and repeated review is blocked', () => {
  const migration = readFileSync(
    new URL('../migrations/20261018_payment_notifications_review_fields.sql', import.meta.url),
    'utf8'
  );
  const rejectedBranch = migration.match(/IF p_action = 'Rejected' THEN([\s\S]*?)END IF;/i)?.[1] || '';
  assert.match(rejectedBranch, /UPDATE public\.payment_notifications/i);
  assert.doesNotMatch(rejectedBranch, /UPDATE public\.payments/i);
  assert.match(migration, /v_notification\.status <> 'Pending Verification'[\s\S]*?already been reviewed/i);
  assert.ok(migration.indexOf("v_notification.status <> 'Pending Verification'") < migration.indexOf('v_remaining := ROUND'));
});

test('payment normalization counts verified full and partial allocations but ignores pending or rejected amounts', () => {
  const full = normalizePaymentRecord({
    amount: 1200,
    paid_amount: 1200,
    verification_status: 'Verified',
    status: 'Paid',
  });
  const partial = normalizePaymentRecord({
    amount: 1200,
    paid_amount: 450,
    verification_status: 'Verified',
    status: 'Partially Paid',
  });
  const pending = normalizePaymentRecord({
    amount: 1200,
    paid_amount: 450,
    verification_status: 'Pending Verification',
    status: 'Partially Paid',
  });
  const rejected = normalizePaymentRecord({
    amount: 1200,
    paid_amount: 450,
    verification_status: 'Rejected',
    status: 'Partially Paid',
  });

  assert.deepEqual([full.paidAmount, full.remainingAmount, full.status], [1200, 0, 'Paid']);
  assert.deepEqual([partial.paidAmount, partial.remainingAmount, partial.status], [450, 750, 'Partially Paid']);
  assert.deepEqual([pending.paidAmount, pending.remainingAmount], [0, 1200]);
  assert.deepEqual([rejected.paidAmount, rejected.remainingAmount], [0, 1200]);
});

test('idempotency migration preserves old rows and enforces lease-scoped request keys', () => {
  const migration = readFileSync(
    new URL('../migrations/20261018_payment_notifications_idempotency.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key uuid/i);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS[\s\S]*\(lease_id, idempotency_key\)/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.payment_notifications/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+public\.payment_notifications/i);
});
