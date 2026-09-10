import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentRecord } from '../src/store.js';

const schema = readFileSync(resolve(process.cwd(), 'backend/src/supabaseSchema.sql'), 'utf8');

test('payments schema supports partial payment tracking', () => {
  assert.match(schema, /create table if not exists payments \(/);
  assert.match(schema, /paid_amount\s+numeric\s+not null\s+default\s+0/);
  assert.match(schema, /status text not null default 'Outstanding' check \(status in \('Paid','Outstanding','Overdue','Partially Paid'\)\)/);
});

test('runtime payment normalization preserves partial-payment balances', () => {
  const payment = normalizePaymentRecord({ amount: 1200, paid_amount: 600, due_date: '2099-01-01' });

  assert.equal(payment.paidAmount, 600);
  assert.equal(payment.remainingAmount, 600);
  assert.equal(payment.status, 'Partially Paid');
});
