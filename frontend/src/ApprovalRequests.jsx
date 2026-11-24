import React, { useCallback, useEffect, useState } from 'react';

const REQUEST_TYPES = [
  ['rent_change', 'Rent change'],
  ['security_deposit_refund', 'Security deposit refund'],
  ['lease_termination', 'Lease termination'],
  ['exceptional_expense', 'Exceptional expense'],
  ['tenant_deletion', 'Tenant deletion'],
];

const prettyType = (value) => REQUEST_TYPES.find(([key]) => key === value)?.[1] || value;
const prettyStatus = (value) => String(value || '').replace(/^./, (letter) => letter.toUpperCase());

export default function ApprovalRequests({ role, token, onShare }) {
  const isAdmin = String(role || '').toLowerCase() === 'admin';
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({
    requestType: 'rent_change',
    title: '',
    reason: '',
    details: '',
  });
  const [reviewReasons, setReviewReasons] = useState({});
  const [expenseOptions, setExpenseOptions] = useState({ properties: [], expenseCategories: [] });
  const [expenseDetails, setExpenseDetails] = useState({
    propertyId: '',
    categoryId: '',
    amount: '',
    description: '',
    expenseOn: '',
    status: 'paid',
    paidOn: '',
    paymentMethod: '',
  });

  const request = useCallback(async (path, options = {}) => {
    const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Approval request action failed.');
    return data;
  }, [token]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await request('/api/approval-requests');
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (isAdmin || form.requestType !== 'exceptional_expense') return undefined;
    let active = true;
    request('/api/approval-requests/options')
      .then((data) => {
        if (active) setExpenseOptions({
          properties: Array.isArray(data.properties) ? data.properties : [],
          expenseCategories: Array.isArray(data.expenseCategories) ? data.expenseCategories : [],
        });
      })
      .catch((err) => {
        if (active) setError(err.message || 'Unable to load expense request options.');
      });
    return () => { active = false; };
  }, [isAdmin, form.requestType, request]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let details = form.details.trim() ? { description: form.details.trim() } : {};
      if (form.requestType === 'exceptional_expense') {
        details = {
          ...expenseDetails,
          amount: Number(expenseDetails.amount),
          paymentMethod: expenseDetails.paymentMethod || null,
          paidOn: expenseDetails.status === 'paid' ? expenseDetails.paidOn : null,
        };
        const requiredFields = ['propertyId', 'categoryId', 'amount', 'description', 'expenseOn'];
        const missingFields = requiredFields.filter((field) => details[field] === undefined || details[field] === null || String(details[field]).trim() === '');
        if (missingFields.length) {
          throw new Error(`Complete the exceptional-expense fields: ${missingFields.join(', ')}.`);
        }
        if (!Number.isFinite(details.amount) || details.amount <= 0) {
          throw new Error('Enter an exceptional-expense amount greater than zero.');
        }
        if (details.status === 'paid' && !details.paidOn) {
          throw new Error('Enter the actual payment date for a paid expense.');
        }
      }
      await request('/api/approval-requests', {
        method: 'POST',
        body: JSON.stringify({
          requestType: form.requestType,
          title: form.title,
          reason: form.reason,
          details,
        }),
      });
      setForm({ requestType: 'rent_change', title: '', reason: '', details: '' });
      setExpenseDetails({
        propertyId: '', categoryId: '', amount: '', description: '',
        expenseOn: '', status: 'paid', paidOn: '', paymentMethod: '',
      });
      setNotice('Approval request submitted to Admin.');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const review = async (item, action) => {
    const reviewReason = String(reviewReasons[item.id] || '').trim();
    if (action === 'reject' && reviewReason.length < 3) {
      setError('Enter a written reason before rejecting this request.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/api/approval-requests/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, reviewReason }),
      });
      const approvalMessages = {
        rent_change: 'Request approved. The requested rent has been updated.',
        security_deposit_refund: 'Request approved. The security-deposit refund has been recorded.',
        lease_termination: 'Request approved. The lease has been terminated.',
        exceptional_expense: 'Request approved. The expense has been recorded.',
        tenant_deletion: 'Request approved. The tenant record has been deleted.',
      };
      setNotice(action === 'approve' ? (approvalMessages[item.requestType] || 'Request approved and applied.') : 'Request rejected. No business change was made.');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stacked-sections">
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      {notice ? <div className="notice success" role="status">{notice}</div> : null}
      {!isAdmin ? (
        <section className="panel">
          <div className="panel-header"><h3>Submit an approval request</h3></div>
          <form className="crud-form" onSubmit={submit}>
            <div className="form-grid">
              <label>
                Request type
                <select value={form.requestType} onChange={(event) => setForm((current) => ({ ...current, requestType: event.target.value }))}>
                  {REQUEST_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>
                Request title
                <input maxLength="200" required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label className="full-span">
                Reason (required)
                <textarea rows="3" maxLength="2000" required value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} />
              </label>
              {form.requestType === 'exceptional_expense' ? (
                <>
                  <label>Property
                    <select value={expenseDetails.propertyId} onChange={(event) => setExpenseDetails((current) => ({ ...current, propertyId: event.target.value }))} required>
                      <option value="">Select property</option>
                      {expenseOptions.properties.map((property) => <option key={property.id} value={property.id}>{property.name || property.id}</option>)}
                    </select>
                  </label>
                  <label>Expense category
                    <select value={expenseDetails.categoryId} onChange={(event) => setExpenseDetails((current) => ({ ...current, categoryId: event.target.value }))} required>
                      <option value="">Select category</option>
                      {expenseOptions.expenseCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </label>
                  <label>Amount (USD)
                    <input type="number" min="0.01" step="0.01" value={expenseDetails.amount} onChange={(event) => setExpenseDetails((current) => ({ ...current, amount: event.target.value }))} required />
                  </label>
                  <label>Expense date
                    <input type="date" value={expenseDetails.expenseOn} onChange={(event) => setExpenseDetails((current) => ({ ...current, expenseOn: event.target.value }))} required />
                  </label>
                  <label className="full-span">Description
                    <input maxLength="2000" value={expenseDetails.description} onChange={(event) => setExpenseDetails((current) => ({ ...current, description: event.target.value }))} required />
                  </label>
                  <label>Expense status
                    <select value={expenseDetails.status} onChange={(event) => setExpenseDetails((current) => ({ ...current, status: event.target.value, paidOn: event.target.value === 'paid' ? current.paidOn : '' }))}>
                      <option value="paid">Paid</option>
                      <option value="unpaid">Unpaid</option>
                    </select>
                  </label>
                  {expenseDetails.status === 'paid' ? (
                    <label>Actual payment date
                      <input type="date" value={expenseDetails.paidOn} onChange={(event) => setExpenseDetails((current) => ({ ...current, paidOn: event.target.value }))} required />
                    </label>
                  ) : null}
                  <label>Payment method (optional)
                    <select value={expenseDetails.paymentMethod} onChange={(event) => setExpenseDetails((current) => ({ ...current, paymentMethod: event.target.value }))}>
                      <option value="">Not specified</option>
                      <option value="Cash">Cash</option>
                      <option value="Bank Transfer">Bank Transfer</option>
                      <option value="Mobile Money">Mobile Money</option>
                      <option value="Other">Other</option>
                    </select>
                  </label>
                  <p className="muted full-span">Admin approval records the expense in Financial Management. It does not transfer money or confirm a cash payment.</p>
                </>
              ) : (
                <label className="full-span">
                  Additional details (optional)
                  <textarea rows="3" maxLength="4000" value={form.details} onChange={(event) => setForm((current) => ({ ...current, details: event.target.value }))} placeholder="Include amounts, tenant/unit, dates, or supporting context." />
                </label>
              )}
            </div>
            <button type="submit" disabled={busy}>{busy ? 'Submitting...' : 'Submit for Admin approval'}</button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h3>{isAdmin ? 'Requests awaiting your review and approval history' : 'My approval requests'}</h3>
          <button type="button" className="secondary-btn" onClick={refresh} disabled={loading}>Refresh</button>
        </div>
        {loading ? <p>Loading approval requests...</p> : items.length === 0 ? <p className="muted">No approval requests found.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Request</th><th>Reason / Details</th><th>Status</th><th>Submitted</th>{isAdmin ? <th>Admin review</th> : <th>Decision</th>}</tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{prettyType(item.requestType)}</strong>
                      <div>{item.title}</div>
                      <small>Request ID: {item.id}</small>
                    </td>
                    <td>
                      <div>{item.reason}</div>
                      {item.details && Object.keys(item.details).length ? (
                        <div className="muted">
                          {Object.entries(item.details).map(([key, value]) => (
                            <div key={key}>
                              {key}: {value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td>{prettyStatus(item.status)}</td>
                    <td>{item.submittedAt ? new Date(item.submittedAt).toLocaleString() : '—'}</td>
                    <td>
                      {isAdmin && item.status === 'pending' ? (
                        <div className="stacked-sections">
                          <textarea rows="2" value={reviewReasons[item.id] || ''} onChange={(event) => setReviewReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Rejection reason required; approval comment optional." />
                          <div className="button-row">
                            <button type="button" disabled={busy} onClick={() => review(item, 'approve')}>Approve</button>
                            <button type="button" className="danger-btn" disabled={busy} onClick={() => review(item, 'reject')}>Reject</button>
                          </div>
                        </div>
                      ) : item.status === 'pending' ? 'Awaiting Admin review' : (
                        <div>
                          <div>{item.status === 'approved' ? ({
                            rent_change: 'Approved — rent updated',
                            security_deposit_refund: 'Approved — deposit refund recorded',
                            lease_termination: 'Approved — lease terminated',
                            exceptional_expense: 'Approved — expense recorded',
                            tenant_deletion: 'Approved — tenant deleted',
                          }[item.requestType] || 'Approved and applied') : 'Rejected by Admin'}</div>
                          {item.reviewReason ? <small>{item.reviewReason}</small> : null}
                          {item.reviewedAt ? <small>{new Date(item.reviewedAt).toLocaleString()}</small> : null}
                        </div>
                      )}
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => onShare?.(`Riiroow Apartments approval request\nType: ${prettyType(item.requestType)}\nTitle: ${item.title}\nReason: ${item.reason}\nDetails: ${item.details?.description || '—'}\nStatus: ${prettyStatus(item.status)}\nSubmitted: ${item.submittedAt ? new Date(item.submittedAt).toLocaleString() : '—'}\nReview note: ${item.reviewReason || '—'}`)}
                      >
                        WhatsApp
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
