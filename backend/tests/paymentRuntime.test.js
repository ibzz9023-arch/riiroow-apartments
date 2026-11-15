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

const { seedState, normalizePaymentRecord } = await import('../src/store.js');
const { createPayment, updatePayment } = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });
writeFileSync(storeFilePath, JSON.stringify(seedState(), null, 2));

const readStore = () => JSON.parse(readFileSync(storeFilePath, 'utf8'));

const restoreStore = (snapshot) => {
  writeFileSync(storeFilePath, JSON.stringify(snapshot, null, 2));
};

test('pending verification cannot appear as paid', () => {
  const result = normalizePaymentRecord({
    amount: 1200,
    paidAmount: 1200,
    status: 'Paid',
    verification_status: 'Pending Verification',
  });

  assert.equal(result.paidAmount, 0);
  assert.equal(result.remainingAmount, 1200);
  assert.equal(result.status, 'Outstanding');
});

test('rejected payment cannot appear as paid', () => {
  const result = normalizePaymentRecord({
    amount: 1200,
    paid_amount: 1200,
    status: 'Paid',
    verification_status: 'Rejected',
    paid_date: '2026-10-20',
  });

  assert.equal(result.paidAmount, 0);
  assert.equal(result.remainingAmount, 1200);
  assert.equal(result.status, 'Outstanding');
});

test('verified partial payment retains its recorded balance', () => {
  const result = normalizePaymentRecord({
    amount: 1200,
    paidAmount: 600,
    status: 'Partially Paid',
    verification_status: 'Verified',
  });

  assert.equal(result.paidAmount, 600);
  assert.equal(result.remainingAmount, 600);
  assert.equal(result.status, 'Partially Paid');
});

test('createPayment refuses rent receipts without a confirmed actual receipt date', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  await assert.rejects(
    createPayment({
      tenant_id: 'tenant-101',
      unit_number: 101,
      amount: 1200,
      paidAmount: 600,
      dueDate: '2099-12-31',
      paidDate: '2099-01-01',
      method: 'ACH',
      notes: 'Runtime test payment',
    }),
    /financial receipts workflow/
  );
  await assert.rejects(
    createPayment({
      tenant_id: 'tenant-101',
      unit_number: 101,
      amount: 1200,
      paidAmount: 0,
      dueDate: '2099-12-31',
      paidDate: '2026-11-03',
      notes: 'Runtime test payment',
    }),
    /Receipt dates must be recorded through the financial receipts workflow/
  );
  assert.deepEqual(readStore(), original);
});

test('updatePayment preserves recorded receipts and rejects paid amount edits', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const existingPayment = readStore().payments.find((entry) => Number(entry.amount) >= 1000 && Number(entry.amount) < 2000);

  assert.ok(existingPayment, 'Expected base payment fixture to exist for update test.');
  const existingPaidAmount = Number(existingPayment.paid_amount ?? existingPayment.paidAmount ?? 0);
  const alteredPaidAmount = existingPaidAmount === 0 ? 1 : existingPaidAmount - 1;

  await assert.rejects(updatePayment(existingPayment.id, {
    tenant_id: existingPayment.tenantId || existingPayment.tenant_id,
    unit_number: existingPayment.unitNumber || existingPayment.unit_number,
    amount: existingPayment.amount,
    paidAmount: alteredPaidAmount,
    dueDate: existingPayment.dueDate || existingPayment.due_date,
    method: existingPayment.method,
    notes: existingPayment.notes || '',
  }), /financial receipts workflow/);

  const result = await updatePayment(existingPayment.id, {
    tenant_id: existingPayment.tenantId || existingPayment.tenant_id,
    unit_number: existingPayment.unitNumber || existingPayment.unit_number,
    amount: existingPayment.amount,
    paidAmount: existingPaidAmount,
    dueDate: existingPayment.dueDate || existingPayment.due_date,
    method: existingPayment.method,
    notes: existingPayment.notes || '',
  });
  assert.equal(result.paidAmount, existingPaidAmount);
  assert.equal(result.paid_amount, existingPaidAmount);

  const persisted = readStore();
  const savedPayment = persisted.payments.find((entry) => entry.id === existingPayment.id);

  assert.ok(savedPayment, 'Expected the updated payment to remain persisted.');
  assert.equal(savedPayment.paid_amount, existingPaidAmount);
});
