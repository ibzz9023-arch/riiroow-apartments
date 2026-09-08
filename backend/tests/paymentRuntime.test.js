import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPayment, updatePayment } from '../src/dataService.js';

const storeFilePath = resolve(process.cwd(), 'data/store.json');

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
