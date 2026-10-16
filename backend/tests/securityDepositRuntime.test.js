import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tempDirectory = join(
  tmpdir(),
  `riiroow-security-deposit-tests-${process.pid}-${Date.now()}`
);
const storeFilePath = join(tempDirectory, 'store.json');

process.env.RIIROOW_DATA_FILE = storeFilePath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { hasSupabase } = await import('../src/supabaseClient.js');

assert.equal(
  hasSupabase,
  false,
  'Security deposit runtime tests must not connect to Supabase.'
);

const { seedState } = await import('../src/store.js');
const {
  getSecurityDepositSummary,
  recordSecurityDepositTransaction,
  updateSecurityDepositTransaction,
  deleteSecurityDepositTransaction,
} = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });

const resetStore = () => {
  const state = seedState();
  const lease = state.leases.find((item) => item.id === 'lease-101');

  assert.ok(lease, 'Expected the synthetic lease-101 test fixture.');
  lease.security_deposit = 1000;
  state.securityDepositTransactions = [];

  writeFileSync(storeFilePath, JSON.stringify(state, null, 2));
};

test.after(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('records a deposit payment and updates the summary', async () => {
  resetStore();

  const transaction = await recordSecurityDepositTransaction(
    'lease-101',
    {
      transactionType: 'payment',
      amount: 300,
      transactionDate: '2026-10-12T10:00:00.000Z',
      notes: 'Automated test payment',
    },
    'automated-test'
  );

  assert.equal(transaction.lease_id, 'lease-101');
  assert.equal(transaction.transaction_type, 'payment');
  assert.equal(transaction.amount, 300);
  assert.equal(transaction.recorded_by, 'automated-test');

  const summary = await getSecurityDepositSummary('lease-101');

  assert.equal(summary.agreedDeposit, 1000);
  assert.equal(summary.depositReceived, 300);
  assert.equal(summary.outstandingDeposit, 700);
  assert.equal(summary.availableDeposit, 300);
  assert.equal(summary.transactions.length, 1);
});

test('rejects a payment exceeding the remaining agreed deposit', async () => {
  resetStore();

  await recordSecurityDepositTransaction('lease-101', {
    transactionType: 'payment',
    amount: 900,
    transactionDate: '2026-10-12T10:00:00.000Z',
  });

  await assert.rejects(
    recordSecurityDepositTransaction('lease-101', {
      transactionType: 'payment',
      amount: 100.01,
      transactionDate: '2026-10-12T10:00:00.000Z',
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary('lease-101');

  assert.equal(summary.depositReceived, 900);
  assert.equal(summary.transactions.length, 1);
});

test('rejects invalid amounts and unsupported transaction types', async () => {
  resetStore();

  for (const amount of [0, -1, 1.234, 1000000001, NaN]) {
    await assert.rejects(
      recordSecurityDepositTransaction('lease-101', {
        transactionType: 'payment',
        amount,
      }),
      (error) => error.code === 'DEPOSIT_VALIDATION',
      `Expected amount ${amount} to be rejected`
    );
  }

  await assert.rejects(
    recordSecurityDepositTransaction('lease-101', {
      transactionType: 'unsupported',
      amount: 10,
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary('lease-101');

  assert.equal(summary.depositReceived, 0);
  assert.equal(summary.transactions.length, 0);
});

test('rejects deductions and refunds exceeding the available deposit', async () => {
  resetStore();

  await assert.rejects(
    recordSecurityDepositTransaction('lease-101', {
      transactionType: 'deduction',
      amount: 1,
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  await assert.rejects(
    recordSecurityDepositTransaction('lease-101', {
      transactionType: 'refund',
      amount: 1,
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary('lease-101');

  assert.equal(summary.transactions.length, 0);
});


test('edits a deposit transaction while preserving its identity and recorder', async () => {
  resetStore();

  const original = await recordSecurityDepositTransaction('lease-101', {
    transactionType: 'payment',
    amount: 300,
    transactionDate: '2026-10-12T10:00:00.000Z',
    notes: 'Original amount',
  }, 'automated-test');

  const updated = await updateSecurityDepositTransaction(
    'lease-101',
    original.id,
    {
      transactionType: 'payment',
      amount: 250,
      transactionDate: '2026-10-13T10:00:00.000Z',
      notes: 'Corrected amount',
    }
  );

  assert.equal(updated.id, original.id);
  assert.equal(updated.amount, 250);
  assert.equal(updated.notes, 'Corrected amount');
  assert.equal(updated.recorded_by, original.recorded_by);

  const summary = await getSecurityDepositSummary('lease-101');
  assert.equal(summary.depositReceived, 250);
  assert.equal(summary.transactions.length, 1);
});

test('deletes a deposit transaction and updates the summary', async () => {
  resetStore();

  const transaction = await recordSecurityDepositTransaction('lease-101', {
    transactionType: 'payment',
    amount: 300,
    transactionDate: '2026-10-12T10:00:00.000Z',
  }, 'automated-test');

  const deleted = await deleteSecurityDepositTransaction(
    'lease-101',
    transaction.id
  );

  assert.equal(deleted.id, transaction.id);

  const summary = await getSecurityDepositSummary('lease-101');
  assert.equal(summary.depositReceived, 0);
  assert.equal(summary.transactions.length, 0);
});

test('prevents edits that would leave deductions above the received deposit', async () => {
  resetStore();

  const payment = await recordSecurityDepositTransaction('lease-101', {
    transactionType: 'payment',
    amount: 300,
    transactionDate: '2026-10-12T10:00:00.000Z',
  });

  await recordSecurityDepositTransaction('lease-101', {
    transactionType: 'deduction',
    amount: 200,
    transactionDate: '2026-10-12T10:00:00.000Z',
  });

  await assert.rejects(
    updateSecurityDepositTransaction('lease-101', payment.id, {
      transactionType: 'payment',
      amount: 100,
      transactionDate: '2026-10-13T10:00:00.000Z',
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary('lease-101');
  assert.equal(summary.depositReceived, 300);
  assert.equal(summary.availableDeposit, 100);
});

