import React, { useEffect, useRef, useState } from 'react';

const canvasWidth = 1400;
const canvasHeight = 420;

export default function LeaseSigning({ lease, requestJson, onCompleted, tenantAccessToken = '', unitNumber = '' }) {
  const [open, setOpen] = useState(Boolean(tenantAccessToken));
  const [session, setSession] = useState(null);
  const [tenantLease, setTenantLease] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const activeStrokeRef = useRef(null);
  const drawingRef = useRef(false);

  const isTenantFlow = Boolean(tenantAccessToken);
  const displayLease = lease || tenantLease || {};
  const signerType = isTenantFlow ? 'tenant' : 'manager';
  const signerName = signerType === 'tenant' ? session?.tenantName : 'Authorized manager';

  useEffect(() => {
    if (!open || (!tenantAccessToken && !lease?.id)) return;
    let active = true;
    setLoading(true);
    setError('');
    const endpoint = isTenantFlow
      ? `/api/public/qr/${encodeURIComponent(unitNumber)}/lease-signing`
      : `/api/leases/${encodeURIComponent(lease.id)}/signing/start`;
    requestJson(endpoint, {
      method: isTenantFlow ? 'GET' : 'POST',
      body: isTenantFlow ? undefined : {},
      headers: isTenantFlow ? { Authorization: `Bearer ${tenantAccessToken}` } : {},
    })
      .then((data) => {
        if (active) {
          setSession(data.session || null);
          if (data.lease) setTenantLease(data.lease);
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || 'Unable to start lease signing.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, lease?.id, tenantAccessToken, unitNumber]);

  const refreshSigningStatus = async () => {
    setLoading(true);
    setError('');
    try {
      const endpoint = isTenantFlow
        ? `/api/public/qr/${encodeURIComponent(unitNumber)}/lease-signing`
        : `/api/leases/${encodeURIComponent(lease.id)}/signing`;
      const data = await requestJson(endpoint, {
        method: 'GET',
        headers: isTenantFlow ? { Authorization: `Bearer ${tenantAccessToken}` } : {},
      });
      setSession(data.session || null);
      if (data.lease) setTenantLease(data.lease);
    } catch (refreshError) {
      setError(refreshError.message || 'Unable to refresh signing status.');
    } finally {
      setLoading(false);
    }
  };

  const pointFromEvent = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const drawStrokes = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#171717';
    strokesRef.current.forEach((stroke) => {
      if (!stroke.length) return;
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      stroke.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.stroke();
    });
  };

  const startStroke = (event) => {
    if (saving) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    canvas.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    activeStrokeRef.current = [pointFromEvent(event)];
    const context = canvas.getContext('2d');
    const point = activeStrokeRef.current[0];
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#171717';
  };

  const continueStroke = (event) => {
    if (!drawingRef.current || !activeStrokeRef.current) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    activeStrokeRef.current.push(point);
    const context = canvasRef.current.getContext('2d');
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const finishStroke = (event) => {
    if (!drawingRef.current || !activeStrokeRef.current) return;
    event.preventDefault();
    strokesRef.current.push(activeStrokeRef.current);
    activeStrokeRef.current = null;
    drawingRef.current = false;
    setHasInk(true);
  };

  const clearSignature = () => {
    strokesRef.current = [];
    activeStrokeRef.current = null;
    drawingRef.current = false;
    setHasInk(false);
    drawStrokes();
  };

  const undoStroke = () => {
    strokesRef.current.pop();
    setHasInk(strokesRef.current.length > 0);
    drawStrokes();
  };

  const saveSignature = async () => {
    if (!canvasRef.current || !strokesRef.current.length || !session?.id) {
      setError('Please write the signature before continuing.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const signatureDataUrl = canvasRef.current.toDataURL('image/png');
      const signatureEndpoint = isTenantFlow
        ? `/api/public/qr/${encodeURIComponent(unitNumber)}/lease-signing/${encodeURIComponent(session.id)}/signature`
        : `/api/leases/${encodeURIComponent(lease.id)}/signing/${encodeURIComponent(session.id)}/signature`;
      const data = await requestJson(signatureEndpoint, {
        method: 'POST',
        headers: isTenantFlow ? { Authorization: `Bearer ${tenantAccessToken}` } : {},
        body: { signerType, signatureDataUrl, confirmed: true },
      });
      setSession(data.session || null);
      clearSignature();
      setConfirmed(false);
      if (data.session?.status === 'signed') {
        onCompleted?.();
      }
    } catch (saveError) {
      setError(saveError.message || 'Unable to save this signature.');
    } finally {
      setSaving(false);
    }
  };

  const retryFinalDocument = async () => {
    if (!session?.id) return;
    setSaving(true);
    setError('');
    try {
      const data = await requestJson(
        `/api/leases/${encodeURIComponent(displayLease.id)}/signing/${encodeURIComponent(session.id)}/finalize`,
        { method: 'POST', body: {} }
      );
      setSession(data.session || null);
      if (data.session?.status === 'signed') onCompleted?.();
    } catch (retryError) {
      setError(retryError.message || 'Unable to generate the signed lease PDF.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="panel" style={{ marginTop: '14px' }}>
        <div className="panel-header">
          <div>
            <h4>Smart Lease Signing</h4>
            <p className="muted">Tenant signs through the PIN-verified unit QR portal; management signs separately using the manager account.</p>
          </div>
          <button className="primary-btn" type="button" onClick={() => setOpen(true)}>
            {isTenantFlow ? 'Review and sign lease' : 'Continue manager signing'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="panel" style={{ marginTop: '14px' }}>
      <div className="panel-header">
        <div>
          <h4>Smart Lease Signing</h4>
          <p className="muted">Handwrite directly on the screen. The server records each signer’s date and time independently.</p>
        </div>
        <button className="small-btn" type="button" onClick={() => { clearSignature(); setConfirmed(false); setOpen(false); }} disabled={saving}>Close</button>
      </div>

      {loading ? <p role="status">Preparing signing session…</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}

      {!loading && session?.status === 'signed' ? (
        <div className="empty-state" role="status">
          <h4>Lease signed and archived</h4>
          <p>Both signatures have been saved. The final PDF is available in this lease’s Documents list and through its QR code.</p>
          <p className="muted">Tenant: {session.tenantSignedAt ? new Date(session.tenantSignedAt).toLocaleString() : '—'}</p>
          <p className="muted">Manager: {session.managerSignedAt ? new Date(session.managerSignedAt).toLocaleString() : '—'}</p>
        </div>
      ) : null}

      {!loading && !session && isTenantFlow ? <p role="status">Management has not prepared this lease for signing yet. Please contact the property manager.</p> : null}
      {!loading && isTenantFlow && session?.status === 'awaiting_manager' ? (
        <div role="status" className="empty-state">
          <h4>Tenant signature received</h4>
          <p>Your handwritten signature has been securely recorded. The manager must now sign to complete the lease.</p>
          <p className="muted">Tenant signed: {session.tenantSignedAt ? new Date(session.tenantSignedAt).toLocaleString() : '—'}</p>
          <button className="small-btn" type="button" onClick={refreshSigningStatus} disabled={loading}>Refresh status</button>
        </div>
      ) : null}
      {!loading && !isTenantFlow && session?.status === 'awaiting_tenant' ? (
        <div role="status" className="empty-state">
          <p>Waiting for the tenant to review and sign using their PIN-verified unit QR portal.</p>
          <button className="small-btn" type="button" onClick={refreshSigningStatus} disabled={loading}>Refresh signing status</button>
        </div>
      ) : null}

      {!loading && session?.status === 'document_pending' && isTenantFlow ? (
        <div role="status" className="empty-state">
          <h4>Both signatures received</h4>
          <p>Your signature and the manager’s signature have been saved. Management is completing the final PDF archive.</p>
          <button className="small-btn" type="button" onClick={refreshSigningStatus} disabled={loading}>Refresh status</button>
        </div>
      ) : null}
      {!loading && session?.status === 'document_pending' && !isTenantFlow ? (
        <div>
          <p>Both signatures are saved. The final PDF still needs to be generated or uploaded.</p>
          <div className="form-actions">
            <button className="primary-btn" type="button" onClick={retryFinalDocument} disabled={saving}>
              {saving ? 'Retrying…' : 'Retry PDF generation'}
            </button>
          </div>
        </div>
      ) : null}

      {!loading && session && ((isTenantFlow && session.status === 'awaiting_tenant') || (!isTenantFlow && session.status === 'awaiting_manager')) ? (
        <div>
          <div className="panel" style={{ marginBottom: '12px' }}>
            <strong>Review lease before signing</strong>
            <div className="form-grid" style={{ marginTop: '10px' }}>
              <div><span className="muted">Tenant</span><p>{displayLease.tenantName || displayLease.tenant_name || session.tenantName || '—'}</p></div>
              <div><span className="muted">Unit</span><p>{displayLease.unitNumber ?? displayLease.unit_number ?? '—'}</p></div>
              <div><span className="muted">Lease created</span><p>{displayLease.createdAt ? new Date(displayLease.createdAt).toLocaleDateString() : '—'}</p></div>
              <div><span className="muted">Lease starts</span><p>{displayLease.startDate || displayLease.start_date || '—'}</p></div>
              <div><span className="muted">Lease ends</span><p>{displayLease.endDate || displayLease.end_date || '—'}</p></div>
              <div><span className="muted">Monthly rent</span><p>{displayLease.monthlyRent ?? displayLease.monthly_rent ?? '—'}</p></div>
              <div><span className="muted">Security deposit</span><p>{displayLease.securityDeposit ?? displayLease.security_deposit ?? '—'}</p></div>
            </div>
            {displayLease.notes ? <p className="muted">{displayLease.notes}</p> : null}
          </div>
          <div className="panel" style={{ background: 'var(--panel-alt)', marginBottom: '12px' }}>
            <strong>{signerType === 'tenant' ? 'Step 1 — Tenant signature' : 'Step 2 — Manager signature'}</strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              {signerType === 'tenant'
                ? `Tenant signing: ${signerName}. Hand the iPad to the tenant to sign.`
                : 'Tenant signature saved. The authorized manager can now sign from the management account.'}
            </p>
            {session.tenantSignedAt ? <p className="muted">Tenant signed: {new Date(session.tenantSignedAt).toLocaleString()}</p> : null}
          </div>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            {signerType === 'tenant' ? 'Tenant handwritten signature' : 'Manager handwritten signature'}
          </label>
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: '12px',
            background: '#ffffff',
            overflow: 'hidden',
            touchAction: 'none',
          }}>
            <canvas
              ref={canvasRef}
              width={canvasWidth}
              height={canvasHeight}
              aria-label={`${signerType} handwritten signature area`}
              onPointerDown={startStroke}
              onPointerMove={continueStroke}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              style={{ display: 'block', width: '100%', height: '210px', touchAction: 'none', cursor: 'crosshair' }}
            />
          </div>
          <p className="muted">Use Apple Pencil or your finger to write naturally. Your signature is captured as handwritten pen strokes.</p>
          <div className="form-actions">
            <button className="small-btn" type="button" onClick={undoStroke} disabled={!hasInk || saving}>Undo</button>
            <button className="small-btn" type="button" onClick={clearSignature} disabled={saving}>Clear</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', margin: '12px 0' }}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>
              {signerType === 'tenant'
                ? 'The tenant confirms that they reviewed this lease and are signing it voluntarily.'
                : 'I confirm that I am the authorized manager and approve this lease for signing.'}
            </span>
          </label>
          <button className="primary-btn" type="button" onClick={saveSignature} disabled={!confirmed || saving || !hasInk}>
            {saving ? 'Saving signature…' : signerType === 'tenant' ? 'Confirm tenant signature' : 'Confirm manager signature'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
