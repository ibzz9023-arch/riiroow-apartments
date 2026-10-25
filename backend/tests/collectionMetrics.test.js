import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCollections } from '../src/store.js';

test('collection metrics distinguish receipt dates from rent periods and ignore pending or rejected amounts', () => {
  const payments = [
    { amount: 200, paidAmount: 200, paidDate: '2026-10-10', dueDate: '2026-10-01', status: 'Paid' },
    { amount: 300, paidAmount: 300, paidDate: '2026-09-30', dueDate: '2026-10-02', status: 'Paid' },
    { amount: 400, paidAmount: 400, paidDate: '2026-01-01', dueDate: '2026-10-05', status: 'Paid' },
    { amount: 900, paidAmount: 900, paidDate: '2026-10-12', dueDate: '2026-10-04', status: 'Paid', verification_status: 'Pending Verification' },
    { amount: 800, paidAmount: 800, paidDate: '2026-10-14', dueDate: '2026-10-04', status: 'Paid', verification_status: 'Rejected' },
  ];

  assert.deepEqual(
    summarizeCollections(payments, new Date(2026, 9, 25)),
    {
      collectedThisMonth: 200,
      collectedThisYear: 900,
      currentMonthRentPaid: 900,
    },
  );
});

test('collection metrics return zero for an empty payment list', () => {
  assert.deepEqual(
    summarizeCollections([], new Date(2026, 9, 25)),
    {
      collectedThisMonth: 0,
      collectedThisYear: 0,
      currentMonthRentPaid: 0,
    },
  );
});