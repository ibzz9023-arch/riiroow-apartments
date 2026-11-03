import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const scenario = {
  leases: [],
  payments: [],
  leaseError: null,
  paymentError: null,
  deleteError: null,
  deleted: [],
  lookups: [],
};

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.action = '';
  }

  select() {
    this.action = 'select';
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  eq(column, value) {
    if (this.action === 'select') {
      scenario.lookups.push({ table: this.table, column, value });
    }
    return this;
  }

  limit() {
    return this;
  }

  then(resolve, reject) {
    let result;

    if (this.action === 'select' && this.table === 'leases') {
      result = {
        data: scenario.leases,
        error: scenario.leaseError,
      };
    } else if (this.action === 'select' && this.table === 'payments') {
      result = {
        data: scenario.payments,
        error: scenario.paymentError,
      };
    } else if (this.action === 'delete') {
      scenario.deleted.push(this.table);
      result = { error: scenario.deleteError };
    } else {
      result = {
        data: null,
        error: new Error(`Unexpected query: ${this.table}.${this.action}`),
      };
    }

    return Promise.resolve(result).then(resolve, reject);
  }
}

const fakeSupabase = {
  from(table) {
    return new FakeQuery(table);
  },
};

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: {
    supabase: fakeSupabase,
    hasSupabase: true,
  },
});

const { deleteEntity } = await import('../src/dataService.js');

const resetScenario = () => {
  scenario.leases = [];
  scenario.payments = [];
  scenario.leaseError = null;
  scenario.paymentError = null;
  scenario.deleteError = null;
  scenario.deleted = [];
  scenario.lookups = [];
};

test('Supabase tenant deletion is blocked when lease history exists', async () => {
  resetScenario();
  scenario.leases = [{ id: 'lease-1' }];

  await assert.rejects(
    deleteEntity('tenants', 'tenant-1'),
    (error) => {
      assert.equal(error.code, 'TENANT_HAS_HISTORY');
      assert.match(error.message, /lease or payment history/i);
      return true;
    },
  );

  assert.deepEqual(scenario.deleted, []);
  assert.deepEqual(
    scenario.lookups.map(({ table, column, value }) => ({ table, column, value })),
    [
      { table: 'leases', column: 'tenant_id', value: 'tenant-1' },
      { table: 'payments', column: 'tenant_id', value: 'tenant-1' },
    ],
  );
});

test('Supabase tenant deletion is blocked when payment history exists', async () => {
  resetScenario();
  scenario.payments = [{ id: 'payment-1' }];

  await assert.rejects(
    deleteEntity('tenants', 'tenant-2'),
    { code: 'TENANT_HAS_HISTORY' },
  );

  assert.deepEqual(scenario.deleted, []);
});

test('Supabase tenant deletion proceeds when no lease or payment history exists', async () => {
  resetScenario();

  assert.equal(await deleteEntity('tenants', 'tenant-3'), true);
  assert.deepEqual(scenario.deleted, ['tenants']);
});

test('Supabase lookup errors stop tenant deletion safely', async () => {
  resetScenario();
  scenario.leaseError = {
    message: 'Simulated lease lookup failure',
    code: 'TEST_LOOKUP_ERROR',
  };

  await assert.rejects(
    deleteEntity('tenants', 'tenant-4'),
    { code: 'TEST_LOOKUP_ERROR' },
  );

  assert.deepEqual(scenario.deleted, []);
});
