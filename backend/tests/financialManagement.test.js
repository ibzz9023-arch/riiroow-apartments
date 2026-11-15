import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test, { beforeEach, mock } from 'node:test';

const rpcCalls = [];
const queryCalls = [];
let rpcResponse = { data: { success: true }, error: null };
const fakeServiceRole = {
  async rpc(name, parameters) {
    rpcCalls.push({ name, parameters });
    return rpcResponse;
  },
  from(table) {
    const query = {
      select(fields) {
        queryCalls.push({ table, select: fields });
        return this;
      },
      gte(field, value) {
        queryCalls.push({ gte: [field, value] });
        return this;
      },
      lte(field, value) {
        queryCalls.push({ lte: [field, value] });
        return this;
      },
      order(field, options) {
        queryCalls.push({ order: [field, options] });
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    return query;
  },
};

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: {
    supabase: null,
    hasSupabase: false,
    supabaseServiceRole: fakeServiceRole,
  },
});

const {
  calculateFinancialSummary,
  recordRentReceipt,
  createFinancialExpense,
  applyTenantCredit,
  refundTenantCredit,
  reconcileLegacyBalance,
  listFinancialExpenses,
} = await import('../src/financialManagement.js');
const { createFinancialRouter } = await import('../src/financialRoutes.js');

const actorId = 'c0a80123-4567-4890-8123-456789abcdef';
const tenantId = 'c0a80123-4567-4890-8123-456789abcdee';
const propertyId = 'c0a80123-4567-4890-8123-456789abcded';
const paymentId = 'c0a80123-4567-4890-8123-456789abcdcc';
const idempotencyKey = 'c0a80123-4567-4890-8123-456789abcd01';

beforeEach(() => {
  rpcCalls.length = 0;
  queryCalls.length = 0;
  rpcResponse = { data: { success: true }, error: null };
});

test('cash receipt, rent income, credit liability and profit remain distinct', () => {
  const summary = calculateFinancialSummary({
    month: '2026-11',
    receipts: [{ id: 'r1', amount: '400.00', received_on: '2026-11-03', status: 'posted' }],
    allocations: [{
      receipt_id: 'r1',
      allocated_amount: '300.00',
      allocated_on: '2026-11-03',
    }],
    creditTransactions: [{
      event_type: 'issued',
      amount: '100.00',
      effective_on: '2026-11-03',
    }],
    expenses: [{
      amount: '80.00',
      paid_on: '2026-11-05',
      status: 'paid',
      category_name: 'Utilities',
    }],
  });

  assert.equal(summary.cashCollected, 400);
  assert.equal(summary.rentIncomeRecognized, 300);
  assert.equal(summary.tenantCreditLiability, 100);
  assert.equal(summary.paidExpenses, 80);
  assert.equal(summary.netProfit, 220);
  assert.deepEqual(summary.expenseBreakdown, { Utilities: 80 });
  assert.equal(summary.currency, 'USD');
  assert.equal(summary.reportingTimezone, 'Africa/Mogadishu');
});

test('applying existing credit recognizes rent without creating cash collected', () => {
  const summary = calculateFinancialSummary({
    month: '2026-12',
    receipts: [],
    allocations: [],
    creditTransactions: [
      { event_type: 'issued', amount: '100.00', effective_on: '2026-11-03' },
      {
        event_type: 'application',
        amount: '-100.00',
        effective_on: '2026-12-02',
        payment_id: paymentId,
      },
    ],
  });

  assert.equal(summary.cashCollected, 0);
  assert.equal(summary.rentIncomeRecognized, 100);
  assert.equal(summary.tenantCreditLiability, 0);
});

test('undated legacy aggregates remain excluded and require acknowledgement', () => {
  const summary = calculateFinancialSummary({
    month: '2026-11',
    legacyBalances: [
      { classification: 'undated', legacy_amount: '125.00' },
      { classification: 'excluded_unverified', legacy_amount: '20.00' },
    ],
  });

  assert.equal(summary.cashCollected, 0);
  assert.equal(summary.rentIncomeRecognized, 0);
  assert.equal(summary.undatedLegacyBalances, 125);
  assert.equal(summary.excludedUnverifiedBalances, 20);
  assert.equal(summary.isComplete, false);
  assert.equal(summary.completenessWarnings.length, 2);
});

test('reconciled legacy balances count only on their explicitly confirmed receipt date', () => {
  const summary = calculateFinancialSummary({
    month: '2026-11',
    legacyBalances: [
      {
        classification: 'reconciled',
        legacy_amount: '125.00',
        source_paid_date: '2026-11-03',
        verification_status: 'Verified',
      },
      {
        classification: 'reconciled',
        legacy_amount: '50.00',
        source_paid_date: '2026-11-03',
        verification_status: 'Rejected',
      },
    ],
  });

  assert.equal(summary.cashCollected, 125);
  assert.equal(summary.rentIncomeRecognized, 125);
  assert.equal(summary.undatedLegacyBalances, 0);
});

test('monthly summary uses inclusive calendar boundaries and flags unresolved records', () => {
  const summary = calculateFinancialSummary({
    month: '2026-02',
    receipts: [
      { id: 'start', amount: '10.00', received_on: '2026-02-01', status: 'posted' },
      { id: 'end', amount: '20.00', received_on: '2026-02-28', status: 'posted' },
      { id: 'next', amount: '30.00', received_on: '2026-03-01', status: 'posted' },
    ],
    allocations: [
      { receipt_id: 'start', allocated_amount: '10.00', allocated_on: '2026-02-01' },
      { receipt_id: 'end', allocated_amount: '20.00', allocated_on: '2026-02-28' },
      { receipt_id: 'next', allocated_amount: '30.00', allocated_on: '2026-03-01' },
    ],
    pendingNotifications: [{ id: 'pending' }],
    unresolvedFinancialRecords: [{ id: 'unbalanced' }],
  });

  assert.equal(summary.periodStart, '2026-02-01');
  assert.equal(summary.periodEnd, '2026-02-28');
  assert.equal(summary.cashCollected, 30);
  assert.equal(summary.rentIncomeRecognized, 30);
  assert.equal(summary.isComplete, false);
  assert.equal(summary.completenessWarnings.length, 2);
});

test('receipt recording requires an actual date and passes idempotency and actor to the RPC', async () => {
  assert.throws(
    () => recordRentReceipt({
        actorId,
        body: {
          tenantId,
          propertyId,
          amount: '400.00',
          paymentMethod: 'Cash',
          idempotencyKey,
        },
      }),
    /Actual receipt date/
  );
  assert.equal(rpcCalls.length, 0);

  await recordRentReceipt({
    actorId,
    body: {
      tenantId,
      propertyId,
      amount: '400.00',
      receivedOn: '2026-11-03',
      paymentMethod: 'Cash',
      idempotencyKey,
      recordingMode: 'Automatic',
    },
  });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'record_rent_receipt');
  assert.equal(rpcCalls[0].parameters.p_received_on, '2026-11-03');
  assert.equal(rpcCalls[0].parameters.p_idempotency_key, idempotencyKey);
  assert.equal(rpcCalls[0].parameters.p_recorded_by, actorId);
  assert.equal(rpcCalls[0].parameters.p_recording_mode, 'Manual');
});

test('single-obligation receipt allocation uses the PostgreSQL field name', async () => {
  await recordRentReceipt({
    actorId,
    body: {
      tenantId,
      propertyId,
      amount: '100.00',
      receivedOn: '2026-11-03',
      paymentMethod: 'Cash',
      idempotencyKey,
      allocations: [{ paymentId, amount: '100.00' }],
    },
  });

  assert.deepEqual(rpcCalls[0].parameters.p_allocations, [
    { payment_id: paymentId, amount: 100 },
  ]);
});

test('multiple receipt allocations use the PostgreSQL field name', async () => {
  await recordRentReceipt({
    actorId,
    body: {
      tenantId,
      propertyId,
      amount: '300.00',
      receivedOn: '2026-11-03',
      paymentMethod: 'Cash',
      idempotencyKey,
      allocations: [
        { paymentId, amount: '100.00' },
        { payment_id: 'c0a80123-4567-4890-8123-456789abcdcd', amount: '200.00' },
      ],
    },
  });

  assert.deepEqual(rpcCalls[0].parameters.p_allocations, [
    { payment_id: paymentId, amount: 100 },
    { payment_id: 'c0a80123-4567-4890-8123-456789abcdcd', amount: 200 },
  ]);
});

test('credit application and refund call separate transactional RPCs', async () => {
  await applyTenantCredit({
    actorId,
    body: {
      tenantId,
      propertyId,
      paymentId,
      amount: '100.00',
      appliedOn: '2026-11-08',
      idempotencyKey,
    },
  });
  await refundTenantCredit({
    actorId,
    body: {
      tenantId,
      propertyId,
      creditTransactionId: paymentId,
      amount: '20.00',
      refundedOn: '2026-11-09',
      paymentMethod: 'Bank Transfer',
      idempotencyKey,
    },
  });

  assert.deepEqual(
    rpcCalls.map((call) => call.name),
    ['apply_tenant_credit', 'refund_tenant_credit']
  );
  assert.equal(rpcCalls[0].parameters.p_payment_id, paymentId);
  assert.equal(rpcCalls[1].parameters.p_credit_transaction_id, paymentId);
});

test('legacy reconciliation requires an explicit date and records the server actor', async () => {
  assert.throws(
    () => reconcileLegacyBalance({
      balanceId: paymentId,
      actorId,
      body: { evidenceNote: 'Bank statement confirms this receipt.' },
    }),
    /Confirmed historical receipt date/
  );
  assert.equal(rpcCalls.length, 0);

  await reconcileLegacyBalance({
    balanceId: paymentId,
    actorId,
    body: {
      sourcePaidDate: '2026-11-03',
      evidenceNote: 'Bank statement reference 2026-11-03 confirms the actual cash receipt.',
      idempotencyKey,
      actorId: 'untrusted-request-actor',
    },
  });

  assert.equal(rpcCalls[0].name, 'reconcile_rent_legacy_balance');
  assert.equal(rpcCalls[0].parameters.p_source_paid_date, '2026-11-03');
  assert.equal(rpcCalls[0].parameters.p_recorded_by, actorId);
});

test('expense creation requires both expense date and actual payment date for paid entries', async () => {
  const expenseBody = {
    propertyId,
    categoryId: paymentId,
    amount: '25.00',
    description: 'Water bill',
    status: 'paid',
    paidOn: '2026-11-04',
    idempotencyKey,
  };
  assert.throws(
    () => createFinancialExpense({ body: expenseBody, actorId }),
    /Expense date/
  );
  assert.equal(rpcCalls.length, 0);

  await createFinancialExpense({
    body: { ...expenseBody, expenseOn: '2026-11-02' },
    actorId,
  });
  assert.equal(rpcCalls[0].name, 'create_financial_expense');
  assert.equal(rpcCalls[0].parameters.p_expense_on, '2026-11-02');
  assert.equal(rpcCalls[0].parameters.p_paid_on, '2026-11-04');
});

test('monthly expense listing filters by expense date so unpaid entries remain visible', async () => {
  await listFinancialExpenses('2026-02');

  assert.ok(queryCalls.some((call) => call.gte?.[0] === 'expense_on' && call.gte[1] === '2026-02-01'));
  assert.ok(queryCalls.some((call) => call.lte?.[0] === 'expense_on' && call.lte[1] === '2026-02-28'));
  assert.ok(queryCalls.some((call) => call.order?.[0] === 'expense_on'));
  assert.ok(!queryCalls.some((call) => call.gte?.[0] === 'paid_on'));
});

test('financial routes derive write actor identity from authenticated request context', async (t) => {
  let recordedReceipt;
  const app = express();
  app.use(express.json());
  app.use('/financial', createFinancialRouter({
    authorize: () => (req, res, next) => {
      req.auth = { sub: actorId, role: 'Manager' };
      next();
    },
    service: {
      async recordRentReceipt(input) {
        recordedReceipt = input;
        return { success: true };
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');

  const response = await fetch(`http://127.0.0.1:${server.address().port}/financial/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ amount: '10.00', actorId: 'untrusted-request-actor' }),
  });

  assert.equal(response.status, 201);
  assert.equal(recordedReceipt.actorId, actorId);
  assert.equal(recordedReceipt.body.actorId, 'untrusted-request-actor');
});

test('financial migration defines atomic posting, credit, history and snapshot safeguards', () => {
  const schema = readFileSync(
    new URL('../migrations/202611140001_financial_management_schema.sql', import.meta.url),
    'utf8'
  );
  const rpcs = readFileSync(
    new URL('../migrations/202611140002_financial_management_rpcs.sql', import.meta.url),
    'utf8'
  );

  for (const table of [
    'rent_receipts',
    'rent_receipt_allocations',
    'rent_legacy_balances',
    'tenant_credit_accounts',
    'tenant_credit_transactions',
    'rent_cash_refunds',
    'financial_expenses',
    'financial_expense_categories',
    'financial_audit_logs',
    'financial_monthly_snapshot_versions',
    'financial_idempotency_records',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, 'i'));
  }
  assert.match(schema, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(schema, /REVOKE ALL ON TABLE/i);
  assert.match(schema, /prevent_finalized_financial_snapshot_mutation/i);
  assert.match(schema, /THEN 'excluded_unverified'/i);
  assert.match(rpcs, /FOR UPDATE/i);
  assert.match(rpcs, /begin_financial_operation/i);
  assert.match(rpcs, /apply_tenant_credit/i);
  assert.match(rpcs, /refund_tenant_credit/i);
  assert.match(rpcs, /cashCollected/i);
  assert.match(rpcs, /rentIncomeRecognized/i);
  assert.match(rpcs, /tenantCreditLiability/i);
  assert.match(rpcs, /Explicit acknowledgement is required/i);
  assert.match(rpcs, /Receipt recording requires the financial receipt endpoint/i);
  const notificationReview = rpcs.match(
    /CREATE OR REPLACE FUNCTION public\.review_payment_notification\([\s\S]*?\$function\$;/i
  )?.[0] || '';
  assert.ok(notificationReview, 'notification review RPC must be defined');
  assert.match(notificationReview, /IF p_action IS NULL OR p_action <> 'Rejected'/i);
  assert.match(notificationReview, /SET status = 'Rejected'/i);
  assert.doesNotMatch(notificationReview, /SET status = 'Verified - Awaiting Rent Recording'/i);
  assert.match(rpcs, /value->>'payment_id'/i);
  assert.match(rpcs, /ORDER BY x\.payment_id/i);
  assert.match(rpcs, /IF v_item\.amount > v_remaining/i);
  assert.match(rpcs, /IF v_item\.amount > v_due/i);
  assert.match(rpcs, /v_credit := v_remaining/i);
  assert.match(rpcs, /'issued'/i);
  assert.match(rpcs, /'application'/i);
  assert.match(rpcs, /'refund'/i);
  assert.match(rpcs, /rent_cash_refunds/i);
  assert.match(rpcs, /voided_at = NOW\(\)/i);
  assert.match(rpcs, /financial_idempotency_records/i);
  assert.match(rpcs, /financial_month_summary_at/i);
  assert.match(rpcs, /source_cutoff/i);
  assert.match(rpcs, /payment notification\(s\) remain unresolved/i);
  assert.match(rpcs, /Explicit acknowledgement is required/i);
  assert.match(rpcs, /source data changed after preparation/i);
  assert.match(rpcs, /verified_at = CASE[\s\S]*COALESCE\(verified_at, NOW\(\)\)/i);
  assert.match(rpcs, /ORDER BY payment_id/i);
  assert.match(schema, /financial_snapshot_version_immutable/i);
  assert.match(schema, /expense_on DATE NOT NULL/i);
  assert.match(rpcs, /reconcile_rent_legacy_balance/i);
  assert.match(rpcs, /classification IN \('undated', 'reconciled'\)/i);
  assert.match(rpcs, /source_paid_date BETWEEN p_period_start AND v_period_end/i);
  assert.match(rpcs, /p_expense_on DATE/i);
  assert.match(schema, /supersedes_version_id/i);
  assert.match(schema, /GRANT SELECT ON TABLE public\.%I TO service_role/i);
  assert.match(schema, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/i);
  assert.doesNotMatch(schema, /GRANT ALL ON TABLE public\.%I TO service_role/i);
});

test('financial routes allow read-only Accountant access and restrict writes', () => {
  const allowedRoles = [];
  const router = createFinancialRouter({
    authorize: (...roles) => {
      allowedRoles.push(...roles);
      return (_request, _response, next) => next();
    },
    service: {},
  });

  assert.deepEqual(allowedRoles, [
    'Admin', 'Manager', 'Accountant',
    'Admin', 'Manager',
  ]);
  assert.ok(router.stack.length > 1);
});
