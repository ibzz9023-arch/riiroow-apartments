import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tempDirectory = join(
  tmpdir(),
  `riiroow-deposit-tests-${process.pid}-${Date.now()}`
);
const storeFilePath = join(tempDirectory, 'store.json');

process.env.RIIROOW_DATA_FILE = storeFilePath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { hasSupabase } = await import('../src/supabaseClient.js');
assert.equal(hasSupabase, false, 'Tests must not connect to Supabase.');

const { seedState } = await import('../src/store.js');
const {
  getSecurityDepositSummary,
  recordSecurityDepositTransaction,
} = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });
writeFileSync(storeFilePath, JSON.stringify(seedState(), null, 2));

const readStore = () =>
  JSON.parse(readFileSync(storeFilePath, 'utf8'));

const prepareLease = (deposit = 1000) => {
  const state = readStore();
  const lease = state.leases?.[0];

  assert.ok(lease, 'Expected a seeded lease for the test.');

  lease.security_deposit = deposit;
  state.securityDepositTransactions = [];

  writeFileSync(storeFilePath, JSON.stringify(state, null, 2));

  return lease;
};

const restoreStore = (snapshot) => {
  writeFileSync(storeFilePath, JSON.stringify(snapshot, null, 2));
};

test('records a deposit payment and calculates the correct balance', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const lease = prepareLease(1000);
  const before = readStore();
  const originalPayments = JSON.stringify(before.payments || []);

  const transaction = await recordSecurityDepositTransaction(lease.id, {
    transactionType: 'payment',
    amount: 400,
    notes: 'Deposit test payment',
  });

  assert.equal(transaction.transaction_type, 'payment');
  assert.equal(transaction.amount, 400);
  assert.equal(transaction.lease_id, lease.id);

  const summary = await getSecurityDepositSummary(lease.id);

  assert.equal(summary.agreedDeposit, 1000);
  assert.equal(summary.depositReceived, 400);
  assert.equal(summary.outstandingDeposit, 600);
  assert.equal(summary.availableDeposit, 400);
  assert.equal(summary.transactions.length, 1);

  const after = readStore();
  assert.equal(
    JSON.stringify(after.payments || []),
    originalPayments,
    'Recording a deposit must not change rent payments.'
  );
});

test('rejects deposit payments above the agreed amount', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const lease = prepareLease(1000);

  await recordSecurityDepositTransaction(lease.id, {
    transactionType: 'payment',
    amount: 800,
  });

  await assert.rejects(
    recordSecurityDepositTransaction(lease.id, {
      transactionType: 'payment',
      amount: 200.01,
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary(lease.id);
  assert.equal(summary.depositReceived, 800);
  assert.equal(summary.transactions.length, 1);
});

test('rejects invalid amounts and transaction types', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const lease = prepareLease(1000);

  for (const amount of [0, -1, 1.001, 'not-a-number']) {
    await assert.rejects(
      recordSecurityDepositTransaction(lease.id, {
        transactionType: 'payment',
        amount,
      }),
      (error) => error.code === 'DEPOSIT_VALIDATION',
      `Expected amount ${String(amount)} to be rejected.`
    );
  }

  await assert.rejects(
    recordSecurityDepositTransaction(lease.id, {
      transactionType: 'rent',
      amount: 10,
    }),
    (error) => error.code === 'DEPOSIT_VALIDATION'
  );

  const summary = await getSecurityDepositSummary(lease.id);
  assert.equal(summary.transactions.length, 0);
});

test('records deductions and refunds without exceeding the available deposit', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const lease = prepareLease(1000);

  await recordSecurityDepositTransaction(lease.id, {
    transactionType: 'payment',
    amount: 600,
  });

  await recordSecurityDepositTransaction(lease.id, {
    transactionType: 'deduction',
    amount: 100,
  });

  await recordSecurityDepositTransaction(lease.id, {
    transactionType: 'refund',
    amount: 200,
  });

  const summary = await getSecurityDepositSummary(lease.id);

  assert.equal(summary.agreedDeposit, 1000);
  assert.equal(summary.depositReceived, 600);
  assert.equal(summary.outstandingDeposit, 400);
  assert.equal(summary.totalDeductions, 100);
  assert.equal(summary.totalRefunded, 200);
  assert.equal(summary.availableDeposit, 300);
  assert.equal(summary.transactions.length, 3);

  for (const transactionType of ['deduction', 'refund']) {
    await assert.rejects(
      recordSecurityDepositTransaction(lease.id, {
        transactionType,
        amount: 300.01,
      }),
      (error) => error.code === 'DEPOSIT_VALIDATION',
      `Expected an excessive ${transactionType} to be rejected.`
    );
  }

  const finalSummary = await getSecurityDepositSummary(lease.id);
  assert.equal(finalSummary.availableDeposit, 300);
  assert.equal(finalSummary.transactions.length, 3);
});
