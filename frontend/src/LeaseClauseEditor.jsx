import React, { useState } from 'react';
import { LEASE_AGREEMENT_CLAUSES } from '../../shared/leaseAgreementClauses.js';

const toDateInput = (value) => value ? String(value).slice(0, 10) : '';

export default function LeaseClauseEditor({ lease, requestJson, requestDownload, onClose, onSaved }) {
  const [clauses, setClauses] = useState(() => LEASE_AGREEMENT_CLAUSES.map((clause) => ({ ...clause })));
  const [fields, setFields] = useState({
    tenantName: lease.tenantName || lease.tenant_name || '',
    unitNumber: String(lease.unitNumber ?? lease.unit_number ?? ''),
    startDate: toDateInput(lease.startDate ?? lease.start_date),
    endDate: toDateInput(lease.endDate ?? lease.end_date),
    monthlyRent: String(lease.monthlyRent ?? lease.monthly_rent ?? ''),
    securityDeposit: String(lease.securityDeposit ?? lease.security_deposit ?? ''),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  const updateClause = (index, field, value) => setClauses((items) =>
    items.map((clause, clauseIndex) => clauseIndex === index ? { ...clause, [field]: value } : clause)
  );

  const saveDraft = async () => {
    if (saving) return;
    if (clauses.length !== 16 || clauses.some((clause) => !clause.title.trim() || !clause.body.trim())) {
      setError('All 16 clauses must have a title and wording.');
      return;
    }
    const rent = Number(fields.monthlyRent);
    const deposit = Number(fields.securityDeposit);
    if (!fields.tenantName.trim() || !fields.unitNumber.trim() ||
        !Number.isFinite(rent) || rent < 0 || !Number.isFinite(deposit) || deposit < 0) {
      setError('Enter a tenant name, unit number, valid rent and valid security deposit.');
      return;
    }
    if (fields.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(fields.startDate)) {
      setError('Enter a valid lease start date.');
      return;
    }
    if (fields.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(fields.endDate)) {
      setError('Enter a valid lease end date.');
      return;
    }
    if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) {
      setError('The lease end date cannot be earlier than the start date.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await requestJson(
        `/api/leases/${encodeURIComponent(lease.id)}/documents/create-corrected-draft`,
        { method: 'POST', body: { clauses, leaseFields: fields } }
      );
      if (!result.downloadUrl || typeof requestDownload !== 'function') {
        throw new Error('The Word file was saved, but its download could not be prepared. Refresh the lease documents and download it from the list.');
      }
      const blob = await requestDownload(result.downloadUrl);
      if (!(blob instanceof Blob) || !blob.size) throw new Error('The Word export returned an empty file.');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = result.document?.originalName || 'Riiroow_Corrected_Lease.docx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      await onSaved?.(result);
    } catch (saveError) {
      setError(saveError.message || 'Unable to export the corrected Word document.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel lease-clause-editor" aria-label="Word-style lease editor">
      <div className="panel-header">
        <div>
          <h3>Word-style lease editor</h3>
          <p className="muted">Edit the lease details and all 16 clauses, then export an editable Word (.docx) draft.</p>
        </div>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>Close editor</button>
      </div>
      <div className="notice warning">
        This editor creates a separate editable Word (.docx) file from the standard 16-clause template. It does not extract text from an existing signed PDF or change the active lease. Review the exported Word document and obtain fresh signatures before it replaces any existing agreement.
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="panel">
        <h4>Lease details</h4>
        <div className="form-grid">
          <label>Tenant name<input value={fields.tenantName} maxLength={160} onChange={(event) => setFields((v) => ({ ...v, tenantName: event.target.value }))} /></label>
          <label>Unit number<input value={fields.unitNumber} maxLength={40} onChange={(event) => setFields((v) => ({ ...v, unitNumber: event.target.value }))} /></label>
          <label>Start date<input type="date" value={fields.startDate} onChange={(event) => setFields((v) => ({ ...v, startDate: event.target.value }))} /></label>
          <label>End date<input type="date" value={fields.endDate} onChange={(event) => setFields((v) => ({ ...v, endDate: event.target.value }))} /></label>
          <label>Monthly rent (USD)<input type="number" min="0" step="0.01" value={fields.monthlyRent} onChange={(event) => setFields((v) => ({ ...v, monthlyRent: event.target.value }))} /></label>
          <label>Security deposit (USD)<input type="number" min="0" step="0.01" value={fields.securityDeposit} onChange={(event) => setFields((v) => ({ ...v, securityDeposit: event.target.value }))} /></label>
        </div>
      </div>
      <h4>Agreement clauses</h4>
      {clauses.map((clause, index) => (
        <div className="panel lease-clause-editor-item" key={index}>
          <label>Clause {index + 1} title<input value={clause.title} maxLength={160} onChange={(event) => updateClause(index, 'title', event.target.value)} /></label>
          <label>Clause {index + 1} wording<textarea rows={5} maxLength={5000} value={clause.body} onChange={(event) => updateClause(index, 'body', event.target.value)} /></label>
        </div>
      ))}
      <div className="form-actions">
        <button type="button" className="secondary-btn" onClick={() => setPreviewOpen((open) => !open)}>
          {previewOpen ? 'Hide content preview' : 'Preview corrected lease'}
        </button>
      </div>
      {previewOpen ? (
        <div className="panel lease-clause-preview">
          <h2>RIIROOW APARTMENTS</h2>
          <h3>RESIDENTIAL LEASE AGREEMENT</h3>
          <p><strong>CORRECTED DRAFT — REQUIRES REVIEW AND RE-SIGNING</strong></p>
          <p><strong>Tenant:</strong> {fields.tenantName} · <strong>Unit:</strong> {fields.unitNumber}</p>
          <p><strong>Start:</strong> {fields.startDate || '—'} · <strong>End:</strong> {fields.endDate || '—'}</p>
          <p><strong>Monthly rent:</strong> {fields.monthlyRent} · <strong>Security deposit:</strong> {fields.securityDeposit}</p>
          {clauses.map((clause, index) => (
            <section key={index}>
              <h4>{clause.title}</h4>
              <p>{clause.body}</p>
            </section>
          ))}
          <p><strong>This is an unsigned draft. Both parties must review and sign before it replaces any existing agreement.</strong></p>
          <p className="muted">This is a content preview; final PDF pagination may differ.</p>
        </div>
      ) : null}
      <div className="form-actions">
        <button type="button" className="primary-btn" disabled={saving} onClick={saveDraft}>{saving ? 'Preparing Word export…' : 'Export corrected lease to Word (.docx)'}</button>
      </div>
    </section>
  );
}
