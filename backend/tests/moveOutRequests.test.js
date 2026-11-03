import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

const firstUnit = {
  id: 'unit-101-property-1',
  property_id: 'property-1',
  unit_number: 101,
};
const secondUnit = {
  id: 'unit-101-property-2',
  property_id: 'property-2',
  unit_number: 101,
};
const firstLease = {
  id: 'lease-101-property-1',
  tenant_id: 'tenant-1',
  unit_id: firstUnit.id,
  property_id: firstUnit.property_id,
  unit_number: firstUnit.unit_number,
  status: 'Active',
};

const tables = {
  units: [],
  leases: [],
  tenants: [],
  move_out_requests: [],
};
let nextId = 1;
let simulateUniqueRace = false;

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.payload = null;
    this.selectedFields = '*';
  }

  select(fields = '*') { this.selectedFields = fields; return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  insert(payload) { this.action = 'insert'; this.payload = payload; return this; }
  update(payload) { this.action = 'update'; this.payload = payload; return this; }
  order() { return this; }

  project(row) {
    if (!row || this.selectedFields === '*') return row;
    return Object.fromEntries(
      this.selectedFields.split(',').map((field) => field.trim())
        .filter((field) => Object.hasOwn(row, field))
        .map((field) => [field, row[field]])
    );
  }

  async execute(single = false) {
    const rows = tables[this.table];
    if (this.action === 'insert') {
      if (simulateUniqueRace || rows.some((row) =>
        row.lease_id === this.payload.lease_id && row.status === 'Pending Review'
      )) {
        return {
          data: null,
          error: {
            code: '23505',
            constraint: 'idx_move_out_requests_one_pending_per_lease',
            message: 'duplicate key value violates unique constraint idx_move_out_requests_one_pending_per_lease',
          },
        };
      }
      const saved = { id: `move-out-${nextId++}`, ...this.payload };
      rows.push(saved);
      return { data: this.project(saved), error: null };
    }

    if (this.action === 'update') {
      const matching = rows.filter((row) =>
        this.filters.every(([key, value]) => String(row[key]) === String(value))
      );
      for (const row of matching) Object.assign(row, this.payload);
      const updated = matching.map((row) => this.project(row));
      return { data: single ? updated[0] ?? null : updated, error: null };
    }

    const selected = rows.filter((row) =>
      this.filters.every(([key, value]) => String(row[key]) === String(value))
    ).map((row) => this.project(row));
    return { data: single ? selected[0] ?? null : selected, error: null };
  }

  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

const fakeSupabase = { from: (table) => new FakeQuery(table) };
mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: { supabaseServiceRole: fakeSupabase },
});

const { submitTenantMoveOutRequest, listManagerMoveOutRequests, reviewMoveOutRequest } = await import('../src/moveOutRequests.js');

const tomorrow = () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
const access = {
  leaseId: firstLease.id,
  tenantId: firstLease.tenant_id,
  unitId: firstUnit.id,
  propertyId: firstUnit.property_id,
  unitNumber: firstUnit.unit_number,
};
const submit = (overrides = {}) => submitTenantMoveOutRequest({
  access,
  requestedUnitNumber: '101',
  body: { requestedMoveOutDate: tomorrow(), reason: 'Moving' },
  ...overrides,
});

beforeEach(() => {
  tables.units.length = 0;
  tables.units.push(firstUnit, secondUnit);
  tables.leases.length = 0;
  tables.leases.push(firstLease, {
    ...firstLease,
    id: 'lease-101-property-2',
    tenant_id: 'tenant-2',
    unit_id: secondUnit.id,
    property_id: secondUnit.property_id,
  });
  tables.tenants.length = 0;
  tables.move_out_requests.length = 0;
  nextId = 1;
  simulateUniqueRace = false;
});

test('move-out request uses the exact authenticated unit/property despite duplicate unit numbers', async () => {
  const result = await submit();
  assert.equal(result.status, 201);
  assert.equal(tables.move_out_requests.length, 1);
  assert.equal(tables.move_out_requests[0].lease_id, firstLease.id);
  assert.equal(tables.move_out_requests[0].unit_id, firstUnit.id);
  assert.equal(tables.move_out_requests[0].property_id, firstUnit.property_id);
});

test('move-out request rejects a session whose unit/property differs from its lease', async () => {
  const result = await submit({
    access: { ...access, unitId: secondUnit.id, propertyId: secondUnit.property_id },
  });
  assert.equal(result.status, 403);
  assert.equal(tables.move_out_requests.length, 0);
});

test('existing pending move-out request returns conflict without inserting another', async () => {
  tables.move_out_requests.push({
    id: 'existing-request',
    lease_id: firstLease.id,
    status: 'Pending Review',
    requested_move_out_date: tomorrow(),
    submitted_at: new Date().toISOString(),
  });
  const result = await submit();
  assert.equal(result.status, 409);
  assert.equal(result.body.request.id, 'existing-request');
  assert.equal(tables.move_out_requests.length, 1);
});

test('unique-index race for a pending move-out request returns conflict', async () => {
  simulateUniqueRace = true;
  const result = await submit();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'MOVE_OUT_REQUEST_PENDING');
  assert.equal(tables.move_out_requests.length, 0);
});

test('manager list includes tenant names instead of only tenant IDs', async () => {
  tables.tenants.push(
    { id: 'tenant-1', name: 'Test Tenant One' },
    { id: 'tenant-2', name: 'Test Tenant Two' }
  );

  tables.move_out_requests.push(
    {
      id: 'request-pending',
      lease_id: firstLease.id,
      tenant_id: 'tenant-1',
      status: 'Pending Review',
      requested_move_out_date: tomorrow(),
      submitted_at: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 'request-approved',
      lease_id: 'old-lease',
      tenant_id: 'tenant-2',
      status: 'Approved',
      requested_move_out_date: tomorrow(),
      submitted_at: '2026-10-19T10:00:00.000Z',
    }
  );

  const result = await listManagerMoveOutRequests();

  assert.equal(result.status, 200);
  assert.equal(result.body.requests.length, 2);
  assert.equal(result.body.requests[0].tenant_name, 'Test Tenant One');
  assert.equal(result.body.requests[1].tenant_name, 'Test Tenant Two');
});

test('manager can approve a pending move-out request without terminating the lease', async () => {
  tables.move_out_requests.push({
    id: 'request-to-approve',
    lease_id: firstLease.id,
    status: 'Pending Review',
    requested_move_out_date: tomorrow(),
    reason: 'Moving',
  });

  const result = await reviewMoveOutRequest({
    requestId: 'request-to-approve',
    action: 'Approved',
    reviewNote: 'Approved by manager',
    reviewedBy: 'manager-1',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'Approved');
  assert.equal(result.body.request.review_note, 'Approved by manager');
  assert.ok(result.body.request.reviewed_at);
  assert.equal(tables.leases[0].status, 'Active');
});

test('manager can reject a pending move-out request', async () => {
  tables.move_out_requests.push({
    id: 'request-to-reject',
    lease_id: firstLease.id,
    status: 'Pending Review',
    requested_move_out_date: tomorrow(),
  });

  const result = await reviewMoveOutRequest({
    requestId: 'request-to-reject',
    action: 'Rejected',
    reviewNote: 'Please discuss the date',
    reviewedBy: 'manager-1',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'Rejected');
  assert.equal(result.body.request.review_note, 'Please discuss the date');
});

test('manager review rejects invalid actions and oversized notes', async () => {
  const invalidAction = await reviewMoveOutRequest({
    requestId: 'request-1',
    action: 'Terminate Lease',
  });
  assert.equal(invalidAction.status, 400);

  const oversizedNote = await reviewMoveOutRequest({
    requestId: 'request-1',
    action: 'Approved',
    reviewNote: 'x'.repeat(1001),
  });
  assert.equal(oversizedNote.status, 400);
});

test('manager cannot review an already reviewed request again', async () => {
  tables.move_out_requests.push({
    id: 'already-approved',
    lease_id: firstLease.id,
    status: 'Approved',
    requested_move_out_date: tomorrow(),
  });

  const result = await reviewMoveOutRequest({
    requestId: 'already-approved',
    action: 'Rejected',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.status, 'Approved');
  assert.equal(tables.move_out_requests[0].status, 'Approved');
});

test('manager review returns not found for an unknown request', async () => {
  const result = await reviewMoveOutRequest({
    requestId: 'missing-request',
    action: 'Approved',
  });

  assert.equal(result.status, 404);
});
