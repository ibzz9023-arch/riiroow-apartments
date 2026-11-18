import React, { useEffect, useState } from 'react';

const todayInReportingZone = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Mogadishu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const currentReportingMonth = () => todayInReportingZone().slice(0, 7);
const makeIdempotencyKey = () => globalThis.crypto.randomUUID();
const getPropertyId = (record) => record?.propertyId ?? record?.property_id ?? null;
const getTenantId = (record) => record?.tenantId ?? record?.tenant_id ?? null;
const getLeaseId = (record) => record?.leaseId ?? record?.lease_id ?? null;
const getPaymentId = (record) => record?.paymentId ?? record?.payment_id ?? record?.id;

const formatMoney = (amount) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
}).format(Number(amount || 0));

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
};

const statusClass = (status) => `tag ${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Other'];

export default function FinancialManagement({ requestJson, canWrite, dashboard }) {
  const [month, setMonth] = useState(currentReportingMonth);
  const [summary, setSummary] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [credits, setCredits] = useState([]);
  const [legacyBalances, setLegacyBalances] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [creditTransactions, setCreditTransactions] = useState([]);
  const [refundCreditTransactions, setRefundCreditTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [expenseForm, setExpenseForm] = useState({
    propertyId: '',
    categoryId: '',
    amount: '',
    description: '',
    expenseOn: '',
    status: 'paid',
    paidOn: '',
    paymentMethod: '',
    transactionReference: '',
  });
  const [expenseKey, setExpenseKey] = useState(makeIdempotencyKey);
  const [expenseVoidReasons, setExpenseVoidReasons] = useState({});
  const [receiptForm, setReceiptForm] = useState({
    tenantId: '',
    propertyId: '',
    leaseId: '',
    paymentId: '',
    amount: '',
    allocatedAmount: '',
    receivedOn: '',
    paymentMethod: '',
    transactionReference: '',
    reviewNote: '',
  });
  const [receiptKey, setReceiptKey] = useState(makeIdempotencyKey);
  const [receiptVoidReasons, setReceiptVoidReasons] = useState({});
  const [notificationForms, setNotificationForms] = useState({});
  const [applyForm, setApplyForm] = useState({
    accountId: '',
    paymentId: '',
    amount: '',
    appliedOn: '',
    reason: '',
  });
  const [applyKey, setApplyKey] = useState(makeIdempotencyKey);
  const [refundForm, setRefundForm] = useState({
    accountId: '',
    creditTransactionId: '',
    amount: '',
    refundedOn: '',
    paymentMethod: '',
    transactionReference: '',
    reason: '',
  });
  const [refundKey, setRefundKey] = useState(makeIdempotencyKey);
  const [legacyForms, setLegacyForms] = useState({});
  const [incompleteAcknowledgements, setIncompleteAcknowledgements] = useState({});
  const [auditOpen, setAuditOpen] = useState(false);

  const units = dashboard?.units || [];
  const tenants = dashboard?.tenants || [];
  const leases = dashboard?.leases || [];
  const payments = dashboard?.payments || [];
  const propertyMap = new Map();
  (dashboard?.properties || []).forEach((property) => {
    if (property.id) propertyMap.set(String(property.id), property);
  });
  [...units, ...tenants, ...leases, ...payments].forEach((record) => {
    const id = getPropertyId(record);
    if (id && !propertyMap.has(String(id))) propertyMap.set(String(id), { id });
  });
  const properties = [...propertyMap.values()];
  const tenantName = (id) => tenants.find((tenant) => String(tenant.id) === String(id))?.name || 'Unknown tenant';
  const propertyName = (id) => {
    const property = propertyMap.get(String(id));
    return property?.name || property?.propertyName || `Property ${String(id || '').slice(0, 8)}`;
  };
  const accountFor = (id) => credits.find((account) => String(account.id) === String(id));
  const matchingPayments = (tenantId, propertyId) => payments.filter((payment) => (
    String(getTenantId(payment) || '') === String(tenantId || '') &&
    (!propertyId || String(getPropertyId(payment) || '') === String(propertyId)) &&
    Math.max(0, Number(payment.remainingAmount ?? (
      Number(payment.amount || 0) - Number(payment.paidAmount ?? payment.paid_amount ?? 0)
    ))) > 0
  ));

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const monthQuery = encodeURIComponent(month);
      const requests = [
        requestJson(`/api/financial/summary?month=${monthQuery}`),
        requestJson(`/api/financial/receipts?month=${monthQuery}`),
        requestJson(`/api/financial/expenses?month=${monthQuery}`),
        requestJson('/api/financial/expense-categories'),
        requestJson('/api/financial/credits'),
        requestJson('/api/financial/legacy-balances'),
        requestJson(`/api/financial/snapshots/${monthQuery}`),
        requestJson('/api/financial/audit'),
      ];
      if (canWrite) requests.push(requestJson('/api/manager/payment-notifications'));
      const [
        nextSummary,
        nextReceipts,
        nextExpenses,
        nextCategories,
        nextCredits,
        nextLegacyBalances,
        nextSnapshot,
        nextAuditLogs,
        nextNotifications = [],
      ] = await Promise.all(requests);
      setSummary(nextSummary);
      setReceipts(Array.isArray(nextReceipts) ? nextReceipts : []);
      setExpenses(Array.isArray(nextExpenses) ? nextExpenses : []);
      setCategories(Array.isArray(nextCategories) ? nextCategories : []);
      setCredits(Array.isArray(nextCredits) ? nextCredits : []);
      setLegacyBalances(Array.isArray(nextLegacyBalances) ? nextLegacyBalances : []);
      setSnapshot(nextSnapshot);
      setAuditLogs(Array.isArray(nextAuditLogs) ? nextAuditLogs : []);
      setNotifications(Array.isArray(nextNotifications) ? nextNotifications : []);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load financial records.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [month]);

  useEffect(() => {
    if (!expenseForm.propertyId && properties.length > 0) {
      setExpenseForm((previous) => ({ ...previous, propertyId: String(properties[0].id) }));
    }
  }, [properties.length]);

  useEffect(() => {
    if (!expenseForm.categoryId && categories.length > 0) {
      setExpenseForm((previous) => ({ ...previous, categoryId: String(categories[0].id) }));
    }
  }, [categories]);

  useEffect(() => {
    if (!applyForm.accountId && credits.length > 0) {
      setApplyForm((previous) => ({ ...previous, accountId: String(credits[0].id) }));
    }
    if (!refundForm.accountId && credits.length > 0) {
      setRefundForm((previous) => ({ ...previous, accountId: String(credits[0].id) }));
    }
  }, [credits]);

  useEffect(() => {
    if (!applyForm.accountId) {
      setCreditTransactions([]);
      return;
    }
    let active = true;
    requestJson(`/api/financial/credits/${encodeURIComponent(applyForm.accountId)}/transactions`)
      .then((result) => {
        if (active) setCreditTransactions(Array.isArray(result) ? result : []);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || 'Unable to load credit transactions.');
      });
    return () => { active = false; };
  }, [applyForm.accountId]);

  useEffect(() => {
    if (!refundForm.accountId) {
      setRefundCreditTransactions([]);
      return;
    }
    let active = true;
    requestJson(`/api/financial/credits/${encodeURIComponent(refundForm.accountId)}/transactions`)
      .then((result) => {
        if (active) setRefundCreditTransactions(Array.isArray(result) ? result : []);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || 'Unable to load refundable credit transactions.');
      });
    return () => { active = false; };
  }, [refundForm.accountId]);

  const updateExpense = (field, value) => {
    setExpenseForm((previous) => ({ ...previous, [field]: value }));
    setExpenseKey(makeIdempotencyKey());
  };

  const updateReceipt = (field, value) => {
    setReceiptForm((previous) => ({ ...previous, [field]: value }));
    setReceiptKey(makeIdempotencyKey());
  };

  const updateNotification = (id, field, value) => {
    setNotificationForms((previous) => ({
      ...previous,
      [id]: {
        ...previous[id],
        [field]: value,
        idempotencyKey: makeIdempotencyKey(),
      },
    }));
  };

  const runAction = async (label, action, successMessage) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(successMessage);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || 'The financial operation could not be completed.');
    } finally {
      setBusy('');
    }
  };

  const handleCreateCategory = (event) => {
    event.preventDefault();
    void runAction('category', async () => {
      await requestJson('/api/financial/expense-categories', {
        method: 'POST',
        body: { name: newCategoryName.trim() },
      });
      setNewCategoryName('');
    }, 'Expense category created.');
  };

  const handleCreateExpense = (event) => {
    event.preventDefault();
    void runAction('expense', async () => {
      await requestJson('/api/financial/expenses', {
        method: 'POST',
        headers: { 'Idempotency-Key': expenseKey },
        body: { ...expenseForm, idempotencyKey: expenseKey },
      });
      setExpenseForm((previous) => ({
        ...previous,
        amount: '',
        description: '',
        expenseOn: '',
        paidOn: '',
        paymentMethod: '',
        transactionReference: '',
      }));
      setExpenseKey(makeIdempotencyKey());
    }, 'Expense recorded.');
  };

  const handleVoidExpense = (expenseId) => {
    const reason = String(expenseVoidReasons[expenseId] || '').trim();
    if (!reason) {
      setError('Enter a reason before voiding this expense.');
      return;
    }
    void runAction(`void-expense-${expenseId}`, () =>
      requestJson(`/api/financial/expenses/${encodeURIComponent(expenseId)}/void`, {
        method: 'POST',
        body: { reason, idempotencyKey: makeIdempotencyKey() },
      }), 'Expense voided. Create a corrected replacement expense if needed.');
  };

  const handleCreateReceipt = (event) => {
    event.preventDefault();
    void runAction('receipt', async () => {
      const body = {
        tenantId: receiptForm.tenantId,
        propertyId: receiptForm.propertyId,
        leaseId: receiptForm.leaseId || null,
        amount: receiptForm.amount,
        receivedOn: receiptForm.receivedOn,
        paymentMethod: receiptForm.paymentMethod,
        transactionReference: receiptForm.transactionReference,
        reviewNote: receiptForm.reviewNote,
        idempotencyKey: receiptKey,
      };
      if (receiptForm.paymentId) {
        body.allocations = [{
          paymentId: receiptForm.paymentId,
          amount: receiptForm.allocatedAmount || receiptForm.amount,
        }];
      }
      await requestJson('/api/financial/receipts', {
        method: 'POST',
        headers: { 'Idempotency-Key': receiptKey },
        body,
      });
      setReceiptForm((previous) => ({
        ...previous,
        amount: '',
        paymentId: '',
        allocatedAmount: '',
        receivedOn: '',
        paymentMethod: '',
        transactionReference: '',
        reviewNote: '',
      }));
      setReceiptKey(makeIdempotencyKey());
    }, 'Rent receipt recorded. Any unallocated amount is held as tenant credit.');
  };

  const handleRecordNotification = (notification) => {
    const form = notificationForms[notification.id] || {};
    if (!form.receivedOn || !form.paymentMethod) {
      setError('Confirm the actual receipt date and payment method before recording this notification.');
      return;
    }
    const idempotencyKey = form.idempotencyKey || makeIdempotencyKey();
    void runAction(`notification-${notification.id}`, () =>
      requestJson(`/api/financial/receipts/notifications/${encodeURIComponent(notification.id)}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          amount: notification.amount,
          receivedOn: form.receivedOn,
          paymentMethod: form.paymentMethod,
          transactionReference: notification.transaction_reference || '',
          reviewNote: form.reviewNote || '',
          idempotencyKey,
        },
      }), 'Confirmed payment notification recorded as a rent receipt.');
  };

  const handleVoidReceipt = (receiptId) => {
    const form = receiptVoidReasons[receiptId] || {};
    if (!String(form.reason || '').trim() || !form.voidedOn) {
      setError('Enter a void date and reason before correcting this receipt.');
      return;
    }
    void runAction(`void-receipt-${receiptId}`, () =>
      requestJson(`/api/financial/receipts/${encodeURIComponent(receiptId)}/void`, {
        method: 'POST',
        body: {
          voidedOn: form.voidedOn,
          reason: form.reason.trim(),
          idempotencyKey: makeIdempotencyKey(),
        },
      }), 'Receipt voided and its allocations reversed.');
  };

  const handleApplyCredit = (event) => {
    event.preventDefault();
    const account = accountFor(applyForm.accountId);
    if (!account) {
      setError('Select a tenant credit account.');
      return;
    }
    void runAction('apply-credit', async () => {
      await requestJson('/api/financial/credits/apply', {
        method: 'POST',
        headers: { 'Idempotency-Key': applyKey },
        body: {
          tenantId: account.tenant_id,
          propertyId: account.property_id,
          paymentId: applyForm.paymentId,
          amount: applyForm.amount,
          appliedOn: applyForm.appliedOn,
          reason: applyForm.reason,
          idempotencyKey: applyKey,
        },
      });
      setApplyForm((previous) => ({ ...previous, amount: '', appliedOn: '', reason: '' }));
      setApplyKey(makeIdempotencyKey());
    }, 'Tenant credit applied to the selected rent obligation.');
  };

  const handleRefundCredit = (event) => {
    event.preventDefault();
    const account = accountFor(refundForm.accountId);
    if (!account) {
      setError('Select a tenant credit account.');
      return;
    }
    void runAction('refund-credit', async () => {
      await requestJson('/api/financial/credits/refund', {
        method: 'POST',
        headers: { 'Idempotency-Key': refundKey },
        body: {
          tenantId: account.tenant_id,
          propertyId: account.property_id,
          creditTransactionId: refundForm.creditTransactionId,
          amount: refundForm.amount,
          refundedOn: refundForm.refundedOn,
          paymentMethod: refundForm.paymentMethod,
          transactionReference: refundForm.transactionReference,
          reason: refundForm.reason,
          idempotencyKey: refundKey,
        },
      });
      setRefundForm((previous) => ({
        ...previous,
        amount: '',
        refundedOn: '',
        paymentMethod: '',
        transactionReference: '',
        reason: '',
      }));
      setRefundKey(makeIdempotencyKey());
    }, 'Tenant credit refund recorded separately from rent income.');
  };

  const handleReconcileLegacy = (balance) => {
    const form = legacyForms[balance.id] || {};
    if (!form.sourcePaidDate || String(form.evidenceNote || '').trim().length < 20) {
      setError('Confirm the historical receipt date and provide at least 20 characters describing reliable supporting evidence.');
      return;
    }
    const idempotencyKey = form.idempotencyKey || makeIdempotencyKey();
    void runAction(`legacy-${balance.id}`, () =>
      requestJson(`/api/financial/legacy-balances/${encodeURIComponent(balance.id)}/reconcile`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          sourcePaidDate: form.sourcePaidDate,
          evidenceNote: form.evidenceNote.trim(),
          idempotencyKey,
        },
      }), 'Legacy balance reconciled using the confirmed date and supporting evidence.');
  };

  const handlePrepareSnapshot = () => {
    void runAction('prepare-snapshot', () =>
      requestJson(`/api/financial/snapshots/${encodeURIComponent(month)}/prepare`, {
        method: 'POST',
        body: {},
      }), 'Monthly snapshot prepared. Review its completeness before finalization.');
  };

  const handleFinalizeSnapshot = (version) => {
    const acknowledgeIncomplete = !version.is_complete &&
      incompleteAcknowledgements[version.id] === true;
    if (!version.is_complete && !acknowledgeIncomplete) {
      setError('Acknowledge the incomplete snapshot warnings before finalizing.');
      return;
    }
    void runAction(`finalize-${version.id}`, () =>
      requestJson(`/api/financial/snapshots/versions/${encodeURIComponent(version.id)}/finalize`, {
        method: 'POST',
        body: { acknowledgeIncomplete },
      }), 'Snapshot finalized and locked as an immutable version.');
  };

  const filteredExpenses = expenses.filter((expense) => (
    !categoryFilter ||
    String(expense.category_id) === categoryFilter ||
    String(expense.financial_expense_categories?.id) === categoryFilter
  ));
  const currentVersions = snapshot?.versions || [];
  const expenseBreakdownEntries = Object.entries(summary?.expenseBreakdown || {})
    .map(([category, amount]) => ({ category, amount: Number(amount || 0) }))
    .filter((entry) => entry.amount > 0);
  const expenseBreakdownTotal = expenseBreakdownEntries.reduce(
    (total, entry) => total + entry.amount,
    0
  );
  const pieColors = ['#16805c', '#d69a35', '#4f74c8', '#a65f9b', '#c85d5d', '#6a8f9f', '#7d9a55'];
  let pieOffset = 0;
  const pieSegments = expenseBreakdownEntries.map((entry, index) => {
    const percentage = expenseBreakdownTotal > 0 ? (entry.amount / expenseBreakdownTotal) * 100 : 0;
    const start = pieOffset;
    pieOffset += percentage;
    return {
      ...entry,
      percentage,
      color: pieColors[index % pieColors.length],
      start,
      end: pieOffset,
    };
  });
  const pieGradient = pieSegments.length > 0
    ? `conic-gradient(${pieSegments.map((segment) =>
        `${segment.color} ${segment.start}% ${segment.end}%`
      ).join(', ')})`
    : 'conic-gradient(#e5e7eb 0 100%)';
  const selectedApplyAccount = accountFor(applyForm.accountId);
  const applicablePayments = selectedApplyAccount
    ? matchingPayments(selectedApplyAccount.tenant_id, selectedApplyAccount.property_id)
    : [];
  const refundableCredits = refundCreditTransactions.filter((transaction) => {
    if (transaction.event_type !== 'issued') return false;
    const remaining = Number(transaction.amount) + refundCreditTransactions
      .filter((entry) => String(entry.credit_source_transaction_id || '') === String(transaction.id))
      .reduce((total, entry) => total + Number(entry.amount || 0), 0);
    return remaining > 0;
  });

  return (
    <div className="stacked-sections financial-management">
      <section className="panel">
        <div className="panel-header financial-header">
          <div>
            <h2>Financial Management</h2>
            <p className="muted">Cash-basis reporting in USD · Africa/Mogadishu (UTC+3)</p>
          </div>
          <div className="financial-toolbar">
            <label>
              Reporting month
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </label>
            <button type="button" className="secondary-btn" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {notice ? <p className="financial-notice" role="status">{notice}</p> : null}
        {loading && !summary ? <p>Loading financial records...</p> : null}
        {summary ? (
          <>
            <div className="financial-summary-grid">
              <FinancialMetric label="Cash collected" amount={summary.cashCollected} />
              <FinancialMetric label="Cash refunded" amount={summary.cashRefunded} />
              <FinancialMetric label="Recognized rent income" amount={summary.rentIncomeRecognized} />
              <FinancialMetric label="Paid expenses" amount={summary.paidExpenses} />
              <FinancialMetric label="Net profit" amount={summary.netProfit} emphasis />
              <FinancialMetric label="Tenant credit liability" amount={summary.tenantCreditLiability} />
            </div>
            <div className="financial-warning-grid">
              <div><strong>Undated legacy balances</strong><span>{formatMoney(summary.undatedLegacyBalances)}</span></div>
              <div><strong>Unverified legacy balances</strong><span>{formatMoney(summary.excludedUnverifiedBalances)}</span></div>
            </div>
            <p className="muted financial-accounting-note">
              Net profit is recognized rent income minus paid expenses. Cash received, credit liabilities,
              refunds, and security deposits are reported separately.
            </p>
            {summary.completenessWarnings?.length > 0 ? (
              <div className="financial-completeness" role="status">
                <strong>Completeness warnings</strong>
                <ul>{summary.completenessWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            ) : <p className="financial-complete">This month's financial records are complete.</p>}
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>Paid expense breakdown</h3>
            <p className="muted">Expenses are recognized on their actual payment date.</p>
          </div>
        </div>
        {Object.keys(summary?.expenseBreakdown || {}).length === 0 ? (
          <p className="muted">No paid expenses for this reporting month.</p>
        ) : (
          <div className="financial-pie-layout">
            <div
              className="financial-pie-chart"
              role="img"
              aria-label={`Expense breakdown total ${formatMoney(expenseBreakdownTotal)}`}
              style={{ background: pieGradient }}
            >
              <div className="financial-pie-center">
                <span>Total</span>
                <strong>{formatMoney(expenseBreakdownTotal)}</strong>
              </div>
            </div>
            <div className="financial-pie-legend">
              {pieSegments.map((segment) => (
                <div className="financial-pie-legend-row" key={segment.category}>
                  <span className="financial-pie-swatch" style={{ background: segment.color }} />
                  <span>{segment.category}</span>
                  <strong>{formatMoney(segment.amount)}</strong>
                  <span>{segment.percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {canWrite ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Payment notifications awaiting financial recording</h3>
              <p className="muted">
                A notification is not a receipt. Confirm the actual receipt date and method before recording.
              </p>
            </div>
          </div>
          {notifications.filter((notification) => (
            ['Pending Verification', 'Verified - Awaiting Rent Recording'].includes(notification.status)
          )).length === 0 ? (
            <p className="muted">No payment notifications are awaiting receipt recording.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Tenant</th><th>Unit</th><th>Amount</th><th>Submitted method</th><th>Confirmed actual receipt date</th><th>Confirmed method</th><th>Review note</th><th /></tr>
                </thead>
                <tbody>
                  {notifications.filter((notification) => (
                    ['Pending Verification', 'Verified - Awaiting Rent Recording'].includes(notification.status)
                  )).map((notification) => {
                    const form = notificationForms[notification.id] || {};
                    return (
                      <tr key={notification.id}>
                        <td>{notification.tenant_name || tenantName(notification.tenant_id)}</td>
                        <td>{notification.unit_number ?? '—'}</td>
                        <td>{formatMoney(notification.amount)}</td>
                        <td>{notification.payment_method || '—'}</td>
                        <td>
                          <input
                            type="date"
                            aria-label={`Confirmed actual receipt date for ${notification.tenant_name || 'tenant'} payment notification`}
                            value={form.receivedOn || ''}
                            max={todayInReportingZone()}
                            onChange={(event) => updateNotification(notification.id, 'receivedOn', event.target.value)}
                            required
                          />
                        </td>
                        <td>
                          <select
                            aria-label={`Confirmed payment method for ${notification.tenant_name || 'tenant'} payment notification`}
                            value={form.paymentMethod || ''}
                            onChange={(event) => updateNotification(notification.id, 'paymentMethod', event.target.value)}
                            required
                          >
                            <option value="">Confirm method</option>
                            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            value={form.reviewNote || ''}
                            maxLength="1000"
                            aria-label={`Review note for payment notification ${notification.id}`}
                            onChange={(event) => updateNotification(notification.id, 'reviewNote', event.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="small-btn"
                            disabled={Boolean(busy)}
                            onClick={() => handleRecordNotification(notification)}
                          >
                            {busy === `notification-${notification.id}` ? 'Recording...' : 'Confirm and record'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {canWrite ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Record rent receipt</h3>
              <p className="muted">
                Confirm the actual receipt date. Unallocated funds become tenant credit, not rent income.
              </p>
            </div>
          </div>
          <form className="form-grid financial-form" onSubmit={handleCreateReceipt}>
            <label>Tenant
              <select
                value={receiptForm.tenantId}
                onChange={(event) => {
                  const tenant = tenants.find((item) => String(item.id) === event.target.value);
                  const tenantProperty = getPropertyId(tenant) || getPropertyId(
                    units.find((unit) => String(unit.id) === String(tenant?.unitId ?? tenant?.unit_id))
                  ) || '';
                  updateReceipt('tenantId', event.target.value);
                  setReceiptForm((previous) => ({
                    ...previous,
                    tenantId: event.target.value,
                    propertyId: String(tenantProperty),
                    leaseId: '',
                    paymentId: '',
                    allocatedAmount: '',
                  }));
                }}
                required
              >
                <option value="">Select tenant</option>
                {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
              </select>
            </label>
            <label>Property
              <select
                value={receiptForm.propertyId}
                onChange={(event) => updateReceipt('propertyId', event.target.value)}
                required
              >
                <option value="">Select property</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>{property.name || property.propertyName || propertyName(property.id)}</option>
                ))}
              </select>
            </label>
            <label>Lease (optional)
              <select value={receiptForm.leaseId} onChange={(event) => updateReceipt('leaseId', event.target.value)}>
                <option value="">Use tenant's current rent obligations</option>
                {leases.filter((lease) => (
                  String(getTenantId(lease) || '') === String(receiptForm.tenantId) &&
                  String(getPropertyId(lease) || '') === String(receiptForm.propertyId)
                )).map((lease) => (
                  <option key={lease.id} value={lease.id}>
                    {formatDate(lease.startDate ?? lease.start_date)} – {formatDate(lease.endDate ?? lease.end_date)}
                  </option>
                ))}
              </select>
            </label>
            <label>Amount (USD)
              <input type="number" min="0.01" step="0.01" value={receiptForm.amount} onChange={(event) => updateReceipt('amount', event.target.value)} required />
            </label>
            <label>Actual receipt date
              <input type="date" max={todayInReportingZone()} value={receiptForm.receivedOn} onChange={(event) => updateReceipt('receivedOn', event.target.value)} required />
            </label>
            <label>Confirmed payment method
              <select value={receiptForm.paymentMethod} onChange={(event) => updateReceipt('paymentMethod', event.target.value)} required>
                <option value="">Confirm method</option>
                {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
              </select>
            </label>
            <label>Rent obligation (optional)
              <select
                value={receiptForm.paymentId}
                onChange={(event) => {
                  const payment = matchingPayments(receiptForm.tenantId, receiptForm.propertyId)
                    .find((item) => String(getPaymentId(item)) === event.target.value);
                  const due = payment ? Math.max(0, Number(payment.remainingAmount ?? (
                    Number(payment.amount || 0) - Number(payment.paidAmount ?? payment.paid_amount ?? 0)
                  ))) : 0;
                  updateReceipt('paymentId', event.target.value);
                  setReceiptForm((previous) => ({
                    ...previous,
                    paymentId: event.target.value,
                    allocatedAmount: due ? String(Math.min(Number(previous.amount || due), due)) : '',
                  }));
                }}
              >
                <option value="">Allocate to oldest due obligations</option>
                {matchingPayments(receiptForm.tenantId, receiptForm.propertyId).map((payment) => (
                  <option key={getPaymentId(payment)} value={getPaymentId(payment)}>
                    Due {formatDate(payment.dueDate ?? payment.due_date)} · {formatMoney(payment.remainingAmount ?? (
                      Number(payment.amount || 0) - Number(payment.paidAmount ?? payment.paid_amount ?? 0)
                    ))}
                  </option>
                ))}
              </select>
            </label>
            {receiptForm.paymentId ? (
              <label>Amount allocated to this obligation (USD)
                <input type="number" min="0.01" step="0.01" value={receiptForm.allocatedAmount} onChange={(event) => updateReceipt('allocatedAmount', event.target.value)} required />
              </label>
            ) : null}
            <label>Transaction reference (optional)
              <input maxLength="200" value={receiptForm.transactionReference} onChange={(event) => updateReceipt('transactionReference', event.target.value)} />
            </label>
            <label className="full-span">Review note (optional)
              <textarea rows="2" maxLength="1000" value={receiptForm.reviewNote} onChange={(event) => updateReceipt('reviewNote', event.target.value)} />
            </label>
            <div className="form-actions">
              <button type="submit" className="primary-btn" disabled={Boolean(busy) || properties.length === 0}>
                {busy === 'receipt' ? 'Recording...' : 'Record confirmed receipt'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header"><div><h3>Rent receipts</h3><p className="muted">Cash receipts are separate from recognized rent income.</p></div></div>
        {receipts.length === 0 ? <p className="muted">No receipts recorded for this reporting month.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Receipt date</th><th>Tenant</th><th>Amount</th><th>Method</th><th>Source</th><th>Status</th>{canWrite ? <th>Correction</th> : null}</tr></thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td>{formatDate(receipt.received_on)}</td>
                    <td>{tenantName(receipt.tenant_id)}</td>
                    <td>{formatMoney(receipt.amount)}</td>
                    <td>{receipt.payment_method}</td>
                    <td>{receipt.source}</td>
                    <td><span className={statusClass(receipt.status)}>{receipt.status}</span></td>
                    {canWrite ? (
                      <td>
                        {receipt.status === 'posted' ? (
                          <div className="financial-void-fields">
                            <input
                              type="date"
                              aria-label={`Void date for receipt ${receipt.id}`}
                              max={todayInReportingZone()}
                              value={receiptVoidReasons[receipt.id]?.voidedOn || ''}
                              onChange={(event) => setReceiptVoidReasons((previous) => ({
                                ...previous,
                                [receipt.id]: { ...previous[receipt.id], voidedOn: event.target.value },
                              }))}
                            />
                            <input
                              aria-label={`Void reason for receipt ${receipt.id}`}
                              placeholder="Correction reason"
                              value={receiptVoidReasons[receipt.id]?.reason || ''}
                              onChange={(event) => setReceiptVoidReasons((previous) => ({
                                ...previous,
                                [receipt.id]: { ...previous[receipt.id], reason: event.target.value },
                              }))}
                            />
                            <button type="button" className="small-btn danger" disabled={Boolean(busy)} onClick={() => handleVoidReceipt(receipt.id)}>Void receipt</button>
                          </div>
                        ) : receipt.void_reason || '—'}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header financial-header">
          <div><h3>Expense management</h3><p className="muted">Listing uses expense date so unpaid expenses remain visible. Profit uses paid expenses only.</p></div>
          <label className="financial-filter">Category
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="">All categories</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
        </div>
        {canWrite ? (
          <>
            <form className="form-grid financial-form" onSubmit={handleCreateExpense}>
              <label>Property
                <select value={expenseForm.propertyId} onChange={(event) => updateExpense('propertyId', event.target.value)} required>
                  <option value="">Select property</option>
                  {properties.map((property) => <option key={property.id} value={property.id}>{property.name || property.propertyName || propertyName(property.id)}</option>)}
                </select>
              </label>
              <label>Category
                <select value={expenseForm.categoryId} onChange={(event) => updateExpense('categoryId', event.target.value)} required>
                  <option value="">Select category</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </label>
              <label>Expense date
                <input type="date" max={todayInReportingZone()} value={expenseForm.expenseOn} onChange={(event) => updateExpense('expenseOn', event.target.value)} required />
              </label>
              <label>Amount (USD)
                <input type="number" min="0.01" step="0.01" value={expenseForm.amount} onChange={(event) => updateExpense('amount', event.target.value)} required />
              </label>
              <label>Description
                <input maxLength="2000" value={expenseForm.description} onChange={(event) => updateExpense('description', event.target.value)} required />
              </label>
              <label>Status
                <select value={expenseForm.status} onChange={(event) => updateExpense('status', event.target.value)}>
                  <option value="paid">Paid</option>
                  <option value="unpaid">Unpaid</option>
                </select>
              </label>
              {expenseForm.status === 'paid' ? (
                <>
                  <label>Actual payment date
                    <input type="date" max={todayInReportingZone()} value={expenseForm.paidOn} onChange={(event) => updateExpense('paidOn', event.target.value)} required />
                  </label>
                  <label>Payment method
                    <select value={expenseForm.paymentMethod} onChange={(event) => updateExpense('paymentMethod', event.target.value)}>
                      <option value="">Select method (optional)</option>
                      {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                    </select>
                  </label>
                  <label>Payment reference (optional)
                    <input maxLength="200" value={expenseForm.transactionReference} onChange={(event) => updateExpense('transactionReference', event.target.value)} />
                  </label>
                </>
              ) : null}
              <div className="form-actions">
                <button type="submit" className="primary-btn" disabled={Boolean(busy) || properties.length === 0}>
                  {busy === 'expense' ? 'Saving...' : 'Create expense'}
                </button>
              </div>
            </form>
            <form className="financial-category-form" onSubmit={handleCreateCategory}>
              <label htmlFor="financial-category-name">Add expense category</label>
              <input id="financial-category-name" maxLength="80" value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} required />
              <button type="submit" className="secondary-btn" disabled={Boolean(busy)}>Add category</button>
            </form>
          </>
        ) : null}
        {filteredExpenses.length === 0 ? <p className="muted">No expenses for this reporting month and category.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Expense date</th><th>Category</th><th>Description</th><th>Amount</th><th>Status</th><th>Payment date</th><th>Method / reference</th>{canWrite ? <th>Correction</th> : null}</tr></thead>
              <tbody>
                {filteredExpenses.map((expense) => {
                  const category = expense.financial_expense_categories?.name || categories.find((item) => item.id === expense.category_id)?.name || 'Uncategorized';
                  return (
                    <tr key={expense.id}>
                      <td>{formatDate(expense.expense_on)}</td>
                      <td>{category}</td>
                      <td>{expense.description}</td>
                      <td>{formatMoney(expense.amount)}</td>
                      <td><span className={statusClass(expense.status)}>{expense.status}</span></td>
                      <td>{formatDate(expense.paid_on)}</td>
                      <td>{[expense.payment_method, expense.transaction_reference].filter(Boolean).join(' · ') || '—'}</td>
                      {canWrite ? (
                        <td>
                          {expense.status !== 'voided' ? (
                            <div className="financial-void-fields">
                              <input
                                aria-label={`Void reason for expense ${expense.id}`}
                                placeholder="Correction reason"
                                value={expenseVoidReasons[expense.id] || ''}
                                onChange={(event) => setExpenseVoidReasons((previous) => ({
                                  ...previous,
                                  [expense.id]: event.target.value,
                                }))}
                              />
                              <button type="button" className="small-btn danger" disabled={Boolean(busy)} onClick={() => handleVoidExpense(expense.id)}>Void &amp; correct</button>
                            </div>
                          ) : expense.void_reason || '—'}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div><h3>Tenant credit accounts</h3><p className="muted">Credit is a liability until applied to rent or refunded.</p></div></div>
        {credits.length === 0 ? <p className="muted">No tenant credit accounts.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tenant</th><th>Property</th><th>Available credit</th></tr></thead>
              <tbody>{credits.map((account) => (
                <tr key={account.id}>
                  <td>{tenantName(account.tenant_id)}</td>
                  <td>{propertyName(account.property_id)}</td>
                  <td>{formatMoney(account.balance)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {canWrite ? (
          <div className="financial-workflow-grid">
            <form className="form-grid financial-form" onSubmit={handleApplyCredit}>
              <h4 className="full-span">Apply existing credit to rent</h4>
              <label className="full-span">Tenant credit account
                <select value={applyForm.accountId} onChange={(event) => {
                  setApplyForm((previous) => ({ ...previous, accountId: event.target.value, paymentId: '' }));
                  setApplyKey(makeIdempotencyKey());
                }}>
                  <option value="">Select account</option>
                  {credits.map((account) => <option key={account.id} value={account.id}>{tenantName(account.tenant_id)} · {formatMoney(account.balance)}</option>)}
                </select>
              </label>
              <label className="full-span">Rent obligation
                <select value={applyForm.paymentId} onChange={(event) => {
                  setApplyForm((previous) => ({ ...previous, paymentId: event.target.value }));
                  setApplyKey(makeIdempotencyKey());
                }} required>
                  <option value="">Select obligation</option>
                  {applicablePayments.map((payment) => <option key={getPaymentId(payment)} value={getPaymentId(payment)}>{formatDate(payment.dueDate ?? payment.due_date)} · {formatMoney(payment.remainingAmount ?? payment.amount)}</option>)}
                </select>
              </label>
              <label>Amount
                <input type="number" min="0.01" step="0.01" value={applyForm.amount} onChange={(event) => {
                  setApplyForm((previous) => ({ ...previous, amount: event.target.value }));
                  setApplyKey(makeIdempotencyKey());
                }} required />
              </label>
              <label>Application date
                <input type="date" max={todayInReportingZone()} value={applyForm.appliedOn} onChange={(event) => {
                  setApplyForm((previous) => ({ ...previous, appliedOn: event.target.value }));
                  setApplyKey(makeIdempotencyKey());
                }} required />
              </label>
              <label className="full-span">Reason (optional)
                <input maxLength="1000" value={applyForm.reason} onChange={(event) => {
                  setApplyForm((previous) => ({ ...previous, reason: event.target.value }));
                  setApplyKey(makeIdempotencyKey());
                }} />
              </label>
              <div className="form-actions"><button type="submit" className="primary-btn" disabled={Boolean(busy) || !selectedApplyAccount}>Apply credit</button></div>
            </form>
            <form className="form-grid financial-form" onSubmit={handleRefundCredit}>
              <h4 className="full-span">Refund tenant credit</h4>
              <label className="full-span">Tenant credit account
                <select value={refundForm.accountId} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, accountId: event.target.value, creditTransactionId: '' }));
                  setRefundKey(makeIdempotencyKey());
                }}>
                  <option value="">Select account</option>
                  {credits.map((account) => <option key={account.id} value={account.id}>{tenantName(account.tenant_id)} · {formatMoney(account.balance)}</option>)}
                </select>
              </label>
              <label className="full-span">Credit source
                <select value={refundForm.creditTransactionId} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, creditTransactionId: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} required>
                  <option value="">Select issued credit</option>
                  {refundableCredits.map((transaction) => <option key={transaction.id} value={transaction.id}>{formatDate(transaction.effective_on)} · {formatMoney(transaction.amount)}</option>)}
                </select>
              </label>
              <label>Amount
                <input type="number" min="0.01" step="0.01" value={refundForm.amount} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, amount: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} required />
              </label>
              <label>Actual refund date
                <input type="date" max={todayInReportingZone()} value={refundForm.refundedOn} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, refundedOn: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} required />
              </label>
              <label>Payment method
                <select value={refundForm.paymentMethod} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, paymentMethod: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} required>
                  <option value="">Select method</option>
                  {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
              </label>
              <label>Reference (optional)
                <input maxLength="200" value={refundForm.transactionReference} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, transactionReference: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} />
              </label>
              <label className="full-span">Reason (optional)
                <input maxLength="1000" value={refundForm.reason} onChange={(event) => {
                  setRefundForm((previous) => ({ ...previous, reason: event.target.value }));
                  setRefundKey(makeIdempotencyKey());
                }} />
              </label>
              <div className="form-actions"><button type="submit" className="primary-btn" disabled={Boolean(busy)}>Record cash refund</button></div>
            </form>
          </div>
        ) : null}
        <h4>Credit transaction history</h4>
        {creditTransactions.length === 0 ? <p className="muted">Choose an account to view its credit ledger.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Rent obligation</th><th>Reason</th></tr></thead>
              <tbody>{creditTransactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{formatDate(transaction.effective_on)}</td>
                  <td>{transaction.event_type}</td>
                  <td>{formatMoney(transaction.amount)}</td>
                  <td>{transaction.payment_id || '—'}</td>
                  <td>{transaction.reason || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div><h3>Historical rent balances</h3><p className="muted">Undated and unverified balances are excluded from monthly recognized income.</p></div></div>
        {legacyBalances.length === 0 ? <p className="muted">No historical rent balances require reconciliation.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Unit ID</th><th>Tenant ID</th><th>Unit Number</th><th>Tenant</th><th>Amount</th><th>Paid Date</th><th>Verification Status</th><th>Legacy Amount</th><th>Classification</th><th>Recorded Date</th><th>Confirmed Historical Receipt Date</th><th>Reconciled At</th><th>Reconciled By</th>{canWrite ? <th>Evidence / action</th> : <th>Evidence note</th>}</tr></thead>
              <tbody>{legacyBalances.map((balance) => {
                const form = legacyForms[balance.id] || {};
                return (
                  <tr key={balance.id}>
                    <td>{balance.unit_id || '—'}</td>
                    <td>{balance.tenant_id || '—'}</td>
                    <td>{balance.unit_number ?? '—'}</td>
                    <td>{tenantName(balance.tenant_id)}</td>
                    <td>{formatMoney(balance.amount)}</td>
                    <td>{formatDate(balance.paid_date)}</td>
                    <td>
                      {balance.verification_status ? (
                        <span className={statusClass(balance.verification_status)}>
                          {balance.verification_status}
                        </span>
                      ) : '—'}
                    </td>
                    <td>{formatMoney(balance.legacy_amount)}</td>
                    <td>{balance.classification}</td>
                    <td>{formatDate(balance.created_at)}</td>
                    <td>{formatDate(balance.source_paid_date)}</td>
                    <td>{formatDate(balance.reconciled_at)}</td>
                    <td>{balance.reconciled_by || '—'}</td>
                    <td>
                      {balance.classification === 'reconciled' ? (balance.evidence_note || '—') : canWrite && balance.classification === 'undated' ? (
                        <div className="financial-legacy-fields">
                          <input
                            type="date"
                            max={todayInReportingZone()}
                            aria-label={`Confirmed receipt date for legacy balance ${balance.id}`}
                            value={form.sourcePaidDate || ''}
                            onChange={(event) => setLegacyForms((previous) => ({
                              ...previous,
                              [balance.id]: {
                                ...previous[balance.id],
                                sourcePaidDate: event.target.value,
                                idempotencyKey: makeIdempotencyKey(),
                              },
                            }))}
                          />
                          <textarea
                            rows="2"
                            minLength="20"
                            maxLength="1000"
                            placeholder="Describe reliable source evidence (at least 20 characters)"
                            value={form.evidenceNote || ''}
                            onChange={(event) => setLegacyForms((previous) => ({
                              ...previous,
                              [balance.id]: {
                                ...previous[balance.id],
                                evidenceNote: event.target.value,
                                idempotencyKey: makeIdempotencyKey(),
                              },
                            }))}
                          />
                          <button type="button" className="small-btn" disabled={Boolean(busy)} onClick={() => handleReconcileLegacy(balance)}>Reconcile with evidence</button>
                        </div>
                      ) : balance.evidence_note || 'Requires authorized reconciliation'}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><h3>Monthly report and snapshots</h3><p className="muted">Finalized versions are immutable. Re-preparing after finalization creates a superseding version.</p></div>
          {canWrite ? <button type="button" className="primary-btn" onClick={handlePrepareSnapshot} disabled={Boolean(busy)}>{busy === 'prepare-snapshot' ? 'Preparing...' : 'Prepare snapshot'}</button> : null}
        </div>
        {currentVersions.length === 0 ? <p className="muted">No monthly snapshots prepared.</p> : (
          <div className="financial-snapshot-list">
            {currentVersions.map((version) => (
              <article className="financial-snapshot-card" key={version.id}>
                <div className="financial-snapshot-heading">
                  <strong>Version {version.version_number}</strong>
                  <span className={statusClass(version.status)}>{version.status}</span>
                  <span>{version.is_complete ? 'Complete' : 'Incomplete'}</span>
                  <time>{formatDate(version.prepared_at)}</time>
                </div>
                <div className="financial-snapshot-metrics">
                  <span>Cash collected: {formatMoney(version.cash_collected)}</span>
                  <span>Recognized rent: {formatMoney(version.rent_income_recognized)}</span>
                  <span>Paid expenses: {formatMoney(version.paid_expenses)}</span>
                  <strong>Net profit: {formatMoney(version.net_profit)}</strong>
                </div>
                {version.completeness_warnings?.length > 0 ? (
                  <ul>{version.completeness_warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                ) : null}
                {version.status === 'finalized' ? (
                  <p className="financial-complete">Finalized {formatDate(version.finalized_at)}. This version cannot be edited.</p>
                ) : canWrite ? (
                  <div className="financial-finalize">
                    {!version.is_complete ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={incompleteAcknowledgements[version.id] === true}
                          onChange={(event) => setIncompleteAcknowledgements((previous) => ({
                            ...previous,
                            [version.id]: event.target.checked,
                          }))}
                        />
                        I acknowledge the listed completeness warnings and authorize finalization.
                      </label>
                    ) : null}
                    <button type="button" className="small-btn" disabled={Boolean(busy)} onClick={() => handleFinalizeSnapshot(version)}>
                      {busy === `finalize-${version.id}` ? 'Finalizing...' : 'Finalize immutable version'}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><h3>Financial audit history</h3><p className="muted">Recent audited financial operations (up to 500 records).</p></div>
          <button type="button" className="secondary-btn" onClick={() => setAuditOpen((open) => !open)}>
            {auditOpen ? 'Hide history' : `Show history (${auditLogs.length})`}
          </button>
        </div>
        {auditOpen ? auditLogs.length === 0 ? <p className="muted">No financial audit records.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Entity</th><th>Action</th><th>Actor</th><th>Reason</th><th>Details</th></tr></thead>
              <tbody>{auditLogs.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.created_at)}</td>
                  <td>{entry.entity_type}</td>
                  <td>{entry.action}</td>
                  <td>{entry.actor_id || '—'}</td>
                  <td>{entry.reason || '—'}</td>
                  <td><code>{JSON.stringify(entry.details || {})}</code></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function FinancialMetric({ label, amount, emphasis = false }) {
  return (
    <div className={`financial-metric${emphasis ? ' financial-metric-emphasis' : ''}`}>
      <span>{label}</span>
      <strong>{formatMoney(amount)}</strong>
    </div>
  );
}
