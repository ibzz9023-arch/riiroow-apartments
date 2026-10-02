import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tempDirectory = join(tmpdir(), `riiroow-payment-tests-${process.pid}-${Date.now()}`);
const storeFilePath = join(tempDirectory, 'store.json');
process.env.RIIROOW_DATA_FILE = storeFilePath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { hasSupabase } = await import('../src/supabaseClient.js');
assert.equal(hasSupabase, false, 'Runtime tests must not connect to Supabase.');

const { seedState } = await import('../src/store.js');
const { createPayment, updatePayment } = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });
writeFileSync(storeFilePath, JSON.stringify(seedState(), null, 2));

const readStore = () => JSON.parse(readFileSync(storeFilePath, 'utf8'));

const restoreStore = (snapshot) => {
  writeFileSync(storeFilePath, JSON.stringify(snapshot, null, 2));
};

test('createPayment persists schema-compatible partial payment data', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const result = await createPayment({
    tenant_id: 'tenant-101',
    unit_number: 101,
    amount: 1200,
    paidAmount: 600,
    dueDate: '2099-12-31',
    paidDate: '2099-01-01',
    method: 'ACH',
    notes: 'Runtime test payment',
  });

  assert.equal(result.paidAmount, 600);
  assert.equal(result.remainingAmount, 600);
  assert.equal(result.status, 'Partially Paid');
  assert.equal(result.paid_amount, 600);

  const persisted = readStore();
  const savedPayment = persisted.payments.find((entry) => entry.id === result.id);

  assert.ok(savedPayment, 'Expected the new payment to be persisted.');
  assert.equal(savedPayment.paid_amount, 600);
  assert.equal(savedPayment.status, 'Partially Paid');
  assert.equal(savedPayment.amount, 1200);
});

test('updatePayment preserves partial payment balances when editing an existing payment', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const existingPayment = readStore().payments.find((entry) => entry.id === 'pay-4');

  assert.ok(existingPayment, 'Expected base payment fixture to exist for update test.');

  const result = await updatePayment(existingPayment.id, {
    tenant_id: existingPayment.tenantId || existingPayment.tenant_id,
    unit_number: existingPayment.unitNumber || existingPayment.unit_number,
    amount: existingPayment.amount,
    paidAmount: 1000,
    dueDate: existingPayment.dueDate || existingPayment.due_date,
    paidDate: '2099-01-05',
    method: existingPayment.method,
    notes: existingPayment.notes || '',
  });

  assert.equal(result.paidAmount, 1000);
  assert.equal(result.remainingAmount, 950);
  assert.equal(result.status, 'Partially Paid');
  assert.equal(result.paid_amount, 1000);

  const persisted = readStore();
  const savedPayment = persisted.payments.find((entry) => entry.id === existingPayment.id);

  assert.ok(savedPayment, 'Expected the updated payment to remain persisted.');
  assert.equal(savedPayment.paid_amount, 1000);
  assert.equal(savedPayment.status, 'Partially Paid');
  assert.equal(savedPayment.remainingAmount, 950);
});
