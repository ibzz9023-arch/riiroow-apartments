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

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/api/approval-requests', {
        method: 'POST',
        body: JSON.stringify({
          requestType: form.requestType,
          title: form.title,
          reason: form.reason,
          details: form.details.trim() ? { description: form.details.trim() } : {},
        }),
      });
      setForm({ requestType: 'rent_change', title: '', reason: '', details: '' });
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
      setNotice(action === 'approve' ? 'Request approved.' : 'Request rejected.');
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
              <label className="full-span">
                Additional details (optional)
                <textarea rows="3" maxLength="4000" value={form.details} onChange={(event) => setForm((current) => ({ ...current, details: event.target.value }))} placeholder="Include amounts, tenant/unit, dates, or supporting context." />
              </label>
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
                      {item.details?.description ? <small>{item.details.description}</small> : null}
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
                          <div>{item.status === 'approved' ? 'Reviewed by Admin' : 'Rejected by Admin'}</div>
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
