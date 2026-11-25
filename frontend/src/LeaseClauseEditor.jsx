import React, { useState } from 'react';
import { LEASE_AGREEMENT_CLAUSES } from '../../shared/leaseAgreementClauses.js';

export default function LeaseClauseEditor({ lease, requestJson, onSaved }) {
  const [clauses, setClauses] = useState(() => LEASE_AGREEMENT_CLAUSES.map((clause) => ({ ...clause })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const updateClause = (index, field, value) => {
    setClauses((current) => current.map((clause, clauseIndex) =>
      clauseIndex === index ? { ...clause, [field]: value } : clause
    ));
  };

  const saveDraft = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await requestJson(
        `/api/leases/${encodeURIComponent(lease.id)}/documents/create-corrected-draft`,
        { method: 'POST', body: { clauses } }
      );
      setMessage(result.message || 'Corrected draft saved as a separate document.');
      await onSaved?.(result);
    } catch (saveError) {
      setError(saveError.message || 'Unable to create the corrected lease draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <h4>Word-style lease clause editor</h4>
      <p className="muted">Edit the clause titles and wording like a document editor. Saving creates a new unsigned corrected PDF draft. It does not alter the live lease record or the original signed agreement.</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {message ? <p className="success-text" role="status">{message}</p> : null}
      {clauses.map((clause, index) => (
        <div className="form-group" key={index} style={{ marginTop: 14 }}>
          <label>Clause {index + 1} title</label>
          <input value={clause.title} maxLength={160} onChange={(event) => updateClause(index, 'title', event.target.value)} />
          <label>Clause {index + 1} wording</label>
          <textarea rows={4} value={clause.body} maxLength={5000} onChange={(event) => updateClause(index, 'body', event.target.value)} />
        </div>
      ))}
      <div className="form-actions">
        <button type="button" className="primary-btn" disabled={saving} onClick={saveDraft}>
          {saving ? 'Creating corrected draft…' : 'Save corrected draft PDF'}
        </button>
      </div>
    </section>
  );
}
