import React, { useEffect, useRef, useState } from 'react';

const canvasWidth = 1400;
const canvasHeight = 420;

export default function LeaseSigning({ lease, requestJson, onCompleted }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const activeStrokeRef = useRef(null);
  const drawingRef = useRef(false);

  const signerType = session?.tenantSignedAt ? 'manager' : 'tenant';
  const signerName = signerType === 'tenant' ? session?.tenantName : 'Authorized manager';

  useEffect(() => {
    if (!open || !lease?.id) return;
    let active = true;
    setLoading(true);
    setError('');
    requestJson(`/api/leases/${encodeURIComponent(lease.id)}/signing/start`, {
      method: 'POST',
      body: {},
    })
      .then((data) => {
        if (active) setSession(data.session || null);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || 'Unable to start lease signing.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, lease?.id]);

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
      const data = await requestJson(
        `/api/leases/${encodeURIComponent(lease.id)}/signing/${encodeURIComponent(session.id)}/signature`,
        {
          method: 'POST',
          body: {
            signerType,
            signatureDataUrl,
            confirmed: true,
          },
        }
      );
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
        `/api/leases/${encodeURIComponent(lease.id)}/signing/${encodeURIComponent(session.id)}/finalize`,
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
            <p className="muted">Tenant and manager sign separately on the iPad using Apple Pencil or finger.</p>
          </div>
          <button className="primary-btn" type="button" onClick={() => setOpen(true)}>
            Start / continue signing
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
        <button className="small-btn" type="button" onClick={() => setOpen(false)} disabled={saving}>Close</button>
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

      {!loading && session?.status === 'document_pending' ? (
        <div>
          <p>Both signatures are saved. The final PDF still needs to be generated or uploaded.</p>
          <div className="form-actions">
            <button className="primary-btn" type="button" onClick={retryFinalDocument} disabled={saving}>
              {saving ? 'Retrying…' : 'Retry PDF generation'}
            </button>
          </div>
        </div>
      ) : null}

      {!loading && session && ['awaiting_tenant', 'awaiting_manager'].includes(session.status) ? (
        <div>
          <div className="panel" style={{ background: 'var(--panel-alt)', marginBottom: '12px' }}>
            <strong>{signerType === 'tenant' ? 'Step 1 — Tenant signature' : 'Step 2 — Manager signature'}</strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              {signerType === 'tenant'
                ? `Tenant signing: ${signerName}. Hand the iPad to the tenant to sign.`
                : 'Tenant signature saved. Hand the iPad to the authorized manager to sign.'}
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
