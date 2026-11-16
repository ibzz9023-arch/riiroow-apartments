import { supabaseServiceRole } from './supabaseClient.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const PAYMENT_METHODS = new Set(['Cash', 'Bank Transfer', 'Mobile Money', 'Other']);
const REPORTING_TIME_ZONE = 'Africa/Mogadishu';

export class FinancialManagementError extends Error {
  constructor(message, code = 'FINANCIAL_VALIDATION') {
    super(message);
    this.name = 'FinancialManagementError';
    this.code = code;
  }
}

const requireServiceRole = () => {
  if (!supabaseServiceRole) {
    throw new FinancialManagementError(
      'Financial services are unavailable until the Supabase service-role client is configured.',
      'FINANCIAL_CONFIGURATION'
    );
  }
  return supabaseServiceRole;
};

const mapDatabaseError = (error) => {
  const code = error?.code;
  const messageByCode = {
    '22023': 'Financial request validation failed.',
    '23505': 'This financial operation conflicts with an existing record.',
    '23514': 'Financial request validation failed.',
    '42501': 'An active Manager or Admin is required.',
    'P0002': 'The requested financial record was not found.',
    '40001': 'The financial record changed concurrently. Refresh and retry.',
  };
  const message = messageByCode[code] || 'Unable to complete the financial operation.';
  const statusCode = code === 'P0002' ? 404 :
    code === '42501' ? 403 :
      ['22023', '23514'].includes(code) ? 400 :
        ['23505', '40001'].includes(code) ? 409 : 500;
  return new FinancialManagementError(message, `HTTP_${statusCode}`);
};

const assertUuid = (value, label, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const normalized = String(value || '').trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new FinancialManagementError(`${label} must be a valid UUID.`);
  }
  return normalized.toLowerCase();
};

const assertMoney = (value, label) => {
  const text = String(value ?? '').trim();
  if (!MONEY_PATTERN.test(text)) {
    throw new FinancialManagementError(`${label} must be a positive USD amount with up to two decimals.`);
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
    throw new FinancialManagementError(`${label} must be a positive USD amount no greater than 1,000,000,000.`);
  }
  return Number(amount.toFixed(2));
};

const assertDate = (value, label) => {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new FinancialManagementError(`${label} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new FinancialManagementError(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return date;
};

const assertMonth = (value) => {
  const month = String(value || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new FinancialManagementError('Period must use YYYY-MM format.');
  }
  return `${month}-01`;
};

const assertIdempotencyKey = (value) =>
  assertUuid(value, 'Idempotency key');

const assertPaymentMethod = (value, label) => {
  if (!PAYMENT_METHODS.has(value)) {
    throw new FinancialManagementError(`${label} must be Cash, Bank Transfer, Mobile Money, or Other.`);
  }
  return value;
};

const cents = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new FinancialManagementError('A financial record contains an invalid amount.', 'FINANCIAL_DATA');
  }
  return Math.round((amount + Number.EPSILON) * 100);
};

const dollars = (value) => Number((value / 100).toFixed(2));
const withinPeriod = (date, start, end) => {
  const value = String(date || '').slice(0, 10);
  return value >= start && value <= end;
};

export const calculateFinancialSummary = ({
  month,
  receipts = [],
  allocations = [],
  allocationReversals = [],
  creditTransactions = [],
  cashRefunds = [],
  expenses = [],
  legacyBalances = [],
  reconciliationWarnings = [],
  pendingNotifications = [],
  unresolvedFinancialRecords = [],
}) => {
  const periodStart = assertMonth(month);
  const [year, monthNumber] = periodStart.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const receiptById = new Map(receipts.map((receipt) => [
    String(receipt.id),
    String(receipt.status || '').toLowerCase(),
  ]));
  const reconciledLegacyCents = legacyBalances.reduce((total, balance) => (
    balance.classification === 'reconciled' &&
    balance.source_paid_date &&
    !['pending verification', 'rejected'].includes(String(balance.verification_status || '').toLowerCase()) &&
    withinPeriod(balance.source_paid_date, periodStart, periodEnd)
      ? total + cents(balance.legacy_amount)
      : total
  ), 0);

  const cashCollectedCents = receipts.reduce((total, receipt) => (
    receiptById.get(String(receipt.id)) === 'posted' &&
    withinPeriod(receipt.received_on ?? receipt.receivedOn, periodStart, periodEnd)
      ? total + cents(receipt.amount)
      : total
  ), reconciledLegacyCents);

  const cashRefundedCents = cashRefunds.reduce((total, refund) => (
    withinPeriod(refund.refunded_on ?? refund.refundedOn, periodStart, periodEnd)
      ? total + cents(refund.amount)
      : total
  ), 0);

  let rentIncomeCents = allocations.reduce((total, allocation) => {
    const receiptStatus = allocation.receipt_status ||
      receiptById.get(String(allocation.receipt_id));
    if (
      String(receiptStatus || '').toLowerCase() !== 'posted' ||
      !withinPeriod(allocation.allocated_on ?? allocation.allocatedOn, periodStart, periodEnd)
    ) return total;
    return total + cents(allocation.allocated_amount ?? allocation.amount);
  }, reconciledLegacyCents);

  rentIncomeCents -= allocationReversals.reduce((total, reversal) => {
    const receiptStatus = reversal.receipt_status ||
      receiptById.get(String(reversal.receipt_id));
    if (
      String(receiptStatus || '').toLowerCase() !== 'posted' ||
      !withinPeriod(reversal.reversed_on ?? reversal.reversedOn, periodStart, periodEnd)
    ) return total;
    return total + cents(reversal.amount);
  }, 0);

  creditTransactions.forEach((transaction) => {
    if (
      !withinPeriod(transaction.effective_on ?? transaction.effectiveOn, periodStart, periodEnd) ||
      !['application', 'reversal'].includes(String(transaction.event_type ?? transaction.eventType))
    ) return;
    const hasRentObligation = transaction.payment_id ?? transaction.paymentId;
    if (hasRentObligation) rentIncomeCents -= cents(transaction.amount);
  });

  let paidExpensesCents = 0;
  const expenseBreakdownCents = new Map();
  expenses.forEach((expense) => {
    if (
      String(expense.status || '').toLowerCase() !== 'paid' ||
      !withinPeriod(expense.paid_on ?? expense.paidOn, periodStart, periodEnd)
    ) return;
    const amount = cents(expense.amount);
    paidExpensesCents += amount;
    const category = String(expense.category_name ?? expense.categoryName ?? 'Uncategorized');
    expenseBreakdownCents.set(category, (expenseBreakdownCents.get(category) || 0) + amount);
  });

  const tenantCreditLiabilityCents = creditTransactions.reduce((total, transaction) => {
    const effectiveOn = String(transaction.effective_on ?? transaction.effectiveOn ?? '').slice(0, 10);
    return effectiveOn && effectiveOn <= periodEnd ? total + cents(transaction.amount) : total;
  }, 0);
  const undatedLegacyCents = legacyBalances.reduce((total, balance) => (
    balance.classification === 'undated' ? total + cents(balance.legacy_amount) : total
  ), 0);
  const excludedUnverifiedCents = legacyBalances.reduce((total, balance) => (
    balance.classification === 'excluded_unverified'
      ? total + cents(balance.legacy_amount)
      : total
  ), 0);

  const warnings = new Set(reconciliationWarnings.map(String));
  if (undatedLegacyCents > 0) {
    warnings.add('Undated historical payment balances are excluded from monthly rent income.');
  }
  if (excludedUnverifiedCents > 0) {
    warnings.add('Historical paid amounts with pending or rejected verification require reconciliation.');
  }
  if (pendingNotifications.length > 0) {
    warnings.add(`${pendingNotifications.length} payment notification(s) remain unresolved.`);
  }
  if (unresolvedFinancialRecords.length > 0) {
    warnings.add(`${unresolvedFinancialRecords.length} financial record(s) require reconciliation.`);
  }
  const completenessWarnings = [...warnings];

  return {
    periodStart,
    periodEnd,
    currency: 'USD',
    reportingTimezone: REPORTING_TIME_ZONE,
    cashCollected: dollars(cashCollectedCents),
    cashRefunded: dollars(cashRefundedCents),
    rentIncomeRecognized: dollars(rentIncomeCents),
    paidExpenses: dollars(paidExpensesCents),
    netProfit: dollars(rentIncomeCents - paidExpensesCents),
    tenantCreditLiability: dollars(tenantCreditLiabilityCents),
    undatedLegacyBalances: dollars(undatedLegacyCents),
    excludedUnverifiedBalances: dollars(excludedUnverifiedCents),
    expenseBreakdown: Object.fromEntries(
      [...expenseBreakdownCents.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, amount]) => [category, dollars(amount)])
    ),
    isComplete: undatedLegacyCents === 0 && excludedUnverifiedCents === 0 && completenessWarnings.length === 0,
    completenessWarnings,
  };
};

const callRpc = async (name, parameters) => {
  const client = requireServiceRole();
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw mapDatabaseError(error);
  return data;
};

const runQuery = async (query) => {
  requireServiceRole();
  const { data, error } = await query;
  if (error) throw mapDatabaseError(error);
  return data;
};

const validateAllocations = (allocations) => {
  if (allocations === undefined || allocations === null) return null;
  if (!Array.isArray(allocations)) {
    throw new FinancialManagementError('Allocations must be an array.');
  }
  const seen = new Set();
  return allocations.map((item) => {
    const paymentId = assertUuid(item?.paymentId ?? item?.payment_id, 'Payment ID');
    if (seen.has(paymentId)) {
      throw new FinancialManagementError('A rent obligation may appear only once per receipt.');
    }
    seen.add(paymentId);
    return {
      payment_id: paymentId,
      amount: assertMoney(item?.amount, 'Allocation amount'),
    };
  });
};

export const getFinancialSummary = (month) =>
  callRpc('financial_month_summary', { p_period_start: assertMonth(month) });

export const listFinancialReceipts = async (month) => {
  const periodStart = assertMonth(month);
  const [year, monthNumber] = periodStart.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return runQuery(
    requireServiceRole()
      .from('rent_receipts')
      .select('*')
      .gte('received_on', periodStart)
      .lte('received_on', periodEnd)
      .order('received_on', { ascending: false })
  );
};

export const recordRentReceipt = ({ body = {}, actorId, notificationId = null }) => {
  const paymentNotificationId = notificationId
    ? assertUuid(notificationId, 'Payment notification ID')
    : assertUuid(body.paymentNotificationId ?? body.payment_notification_id, 'Payment notification ID', { optional: true });

  return callRpc('record_rent_receipt', {
    p_tenant_id: assertUuid(body.tenantId ?? body.tenant_id, 'Tenant ID', { optional: true }),
    p_property_id: assertUuid(body.propertyId ?? body.property_id, 'Property ID', { optional: true }),
    p_lease_id: assertUuid(body.leaseId ?? body.lease_id, 'Lease ID', { optional: true }),
    p_amount: assertMoney(body.amount, 'Receipt amount'),
    p_received_on: assertDate(body.receivedOn ?? body.received_on, 'Actual receipt date'),
    p_payment_method: assertPaymentMethod(body.paymentMethod ?? body.payment_method, 'Payment method'),
    p_transaction_reference: body.transactionReference == null
      ? null
      : String(body.transactionReference).trim(),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
    p_payment_notification_id: paymentNotificationId,
    p_allocations: validateAllocations(body.allocations),
    p_review_note: body.reviewNote == null ? null : String(body.reviewNote).trim(),
    p_recording_mode: 'Manual',
  });
};

export const voidRentReceipt = ({ receiptId, body = {}, actorId }) =>
  callRpc('void_rent_receipt', {
    p_receipt_id: assertUuid(receiptId, 'Receipt ID'),
    p_voided_on: assertDate(body.voidedOn ?? body.voided_on, 'Void date'),
    p_reason: String(body.reason || '').trim(),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });

export const listTenantCredits = async () => runQuery(
  requireServiceRole()
    .from('tenant_credit_accounts')
    .select('id, tenant_id, property_id, balance, created_at, updated_at')
    .order('updated_at', { ascending: false })
);

export const listTenantCreditTransactions = async (accountId) => {
  const normalizedAccountId = assertUuid(accountId, 'Tenant credit account ID');
  return runQuery(
    requireServiceRole()
      .from('tenant_credit_transactions')
      .select('*')
      .eq('account_id', normalizedAccountId)
      .order('effective_on', { ascending: false })
      .order('created_at', { ascending: false })
  );
};

export const listUndatedLegacyBalances = async () => runQuery(
  requireServiceRole()
    .from('rent_legacy_balances_ledger_vw')
    .select('id, payment_id, unit_id, tenant_id, unit_number, amount, paid_date, verification_status, legacy_amount, source_paid_date, classification, evidence_note, reconciled_at, reconciled_by, created_at, property_id, lease_id, due_date, payment_status, payment_paid_amount, historical_tenant_id, historical_verification_status, tenant_id_mismatch, property_id_mismatch')
    .order('created_at', { ascending: true })
);
export const reconcileLegacyBalance = ({ balanceId, body = {}, actorId }) =>
  callRpc('reconcile_rent_legacy_balance', {
    p_balance_id: assertUuid(balanceId, 'Legacy balance ID'),
    p_source_paid_date: assertDate(
      body.sourcePaidDate ?? body.source_paid_date,
      'Confirmed historical receipt date'
    ),
    p_evidence_note: String(body.evidenceNote ?? body.evidence_note ?? '').trim(),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });

export const applyTenantCredit = ({ body = {}, actorId }) =>
  callRpc('apply_tenant_credit', {
    p_tenant_id: assertUuid(body.tenantId ?? body.tenant_id, 'Tenant ID'),
    p_property_id: assertUuid(body.propertyId ?? body.property_id, 'Property ID'),
    p_payment_id: assertUuid(body.paymentId ?? body.payment_id, 'Rent obligation ID'),
    p_amount: assertMoney(body.amount, 'Credit application amount'),
    p_applied_on: assertDate(body.appliedOn ?? body.applied_on, 'Credit application date'),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
    p_reason: body.reason == null ? null : String(body.reason).trim(),
  });

export const refundTenantCredit = ({ body = {}, actorId }) =>
  callRpc('refund_tenant_credit', {
    p_tenant_id: assertUuid(body.tenantId ?? body.tenant_id, 'Tenant ID'),
    p_property_id: assertUuid(body.propertyId ?? body.property_id, 'Property ID'),
    p_credit_transaction_id: assertUuid(
      body.creditTransactionId ?? body.credit_transaction_id,
      'Original credit transaction ID'
    ),
    p_amount: assertMoney(body.amount, 'Refund amount'),
    p_refunded_on: assertDate(body.refundedOn ?? body.refunded_on, 'Refund date'),
    p_payment_method: assertPaymentMethod(body.paymentMethod ?? body.payment_method, 'Refund payment method'),
    p_transaction_reference: body.transactionReference == null
      ? null
      : String(body.transactionReference).trim(),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
    p_reason: body.reason == null ? null : String(body.reason).trim(),
  });

export const listExpenseCategories = async () => runQuery(
  requireServiceRole()
    .from('financial_expense_categories')
    .select('id, name, is_active')
    .eq('is_active', true)
    .order('name', { ascending: true })
);

export const createExpenseCategory = ({ body = {}, actorId }) => {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) {
    throw new FinancialManagementError('Category name is required and must be at most 80 characters.');
  }
  return callRpc('create_financial_expense_category', {
    p_name: name,
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });
};

export const listFinancialExpenses = async (month) => {
  const periodStart = assertMonth(month);
  const [year, monthNumber] = periodStart.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return runQuery(
    requireServiceRole()
      .from('financial_expenses')
      .select('*, financial_expense_categories(id, name)')
      .gte('expense_on', periodStart)
      .lte('expense_on', periodEnd)
      .order('expense_on', { ascending: false })
  );
};

export const createFinancialExpense = ({ body = {}, actorId }) => {
  const status = String(body.status ?? 'paid').trim().toLowerCase();
  if (!['paid', 'unpaid'].includes(status)) {
    throw new FinancialManagementError('Expense status must be paid or unpaid.');
  }
  return callRpc('create_financial_expense', {
    p_property_id: assertUuid(body.propertyId ?? body.property_id, 'Property ID'),
    p_category_id: assertUuid(body.categoryId ?? body.category_id, 'Category ID'),
    p_amount: assertMoney(body.amount, 'Expense amount'),
    p_description: String(body.description || '').trim(),
    p_expense_on: assertDate(body.expenseOn ?? body.expense_on, 'Expense date'),
    p_paid_on: status === 'unpaid'
      ? null
      : assertDate(body.paidOn ?? body.paid_on, 'Actual payment date'),
    p_payment_method: body.paymentMethod ?? body.payment_method ?? null,
    p_transaction_reference: body.transactionReference ?? body.transaction_reference ?? null,
    p_receipt_storage_path: body.receiptStoragePath ?? body.receipt_storage_path ?? null,
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
    p_status: status,
  });
};

export const voidFinancialExpense = ({ expenseId, body = {}, actorId }) =>
  callRpc('void_financial_expense', {
    p_expense_id: assertUuid(expenseId, 'Expense ID'),
    p_reason: String(body.reason || '').trim(),
    p_idempotency_key: assertIdempotencyKey(body.idempotencyKey ?? body.idempotency_key),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });

export const prepareFinancialSnapshot = ({ month, actorId }) =>
  callRpc('prepare_financial_month_snapshot', {
    p_period_start: assertMonth(month),
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });

export const finalizeFinancialSnapshot = ({ versionId, body = {}, actorId }) =>
  callRpc('finalize_financial_month_snapshot', {
    p_version_id: assertUuid(versionId, 'Snapshot version ID'),
    p_acknowledge_incomplete: body.acknowledgeIncomplete === true,
    p_recorded_by: assertUuid(actorId, 'Recorder ID'),
  });

export const getFinancialSnapshot = async (month) => {
  const periodStart = assertMonth(month);
  const client = requireServiceRole();
  const snapshot = await runQuery(
    client
      .from('financial_monthly_snapshots')
      .select('id, period_start, current_finalized_version_id, created_at')
      .eq('period_start', periodStart)
      .maybeSingle()
  );
  if (!snapshot) return null;
  const versions = await runQuery(
    client
      .from('financial_monthly_snapshot_versions')
      .select('*')
      .eq('snapshot_id', snapshot.id)
      .order('version_number', { ascending: false })
  );
  return { ...snapshot, versions: versions || [] };
};

export const listFinancialAuditLogs = async () => runQuery(
  requireServiceRole()
    .from('financial_audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)
);
