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
  const [signatureMethod, setSignatureMethod] = useState('draw');
  const [sourcePhotoDataUrl, setSourcePhotoDataUrl] = useState('');
  const [extractedSignatureDataUrl, setExtractedSignatureDataUrl] = useState('');
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const activeStrokeRef = useRef(null);
  const drawingRef = useRef(false);
  const activePointerIdRef = useRef(null);

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
      if (stroke.length === 1) {
        context.arc(stroke[0].x, stroke[0].y, 2.5, 0, Math.PI * 2);
        context.fill();
        return;
      }
      context.moveTo(stroke[0].x, stroke[0].y);
      stroke.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.stroke();
    });
  };

  const startStroke = (event) => {
    if (saving || drawingRef.current) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    activePointerIdRef.current = event.pointerId;
    activeStrokeRef.current = [pointFromEvent(event)];
    const context = canvas.getContext('2d');
    const point = activeStrokeRef.current[0];
    // Render a dot immediately so a deliberate tap is still a visible mark.
    context.beginPath();
    context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    context.fillStyle = '#171717';
    context.fill();
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#171717';
  };

  const continueStroke = (event) => {
    if (!drawingRef.current || !activeStrokeRef.current || event.pointerId !== activePointerIdRef.current) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    activeStrokeRef.current.push(point);
    const context = canvasRef.current.getContext('2d');
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const finishStroke = (event) => {
    if (!drawingRef.current || !activeStrokeRef.current || event.pointerId !== activePointerIdRef.current) return;
    event.preventDefault();
    strokesRef.current.push(activeStrokeRef.current);
    activeStrokeRef.current = null;
    drawingRef.current = false;
    activePointerIdRef.current = null;
    setHasInk(true);
  };

  const clearSignature = () => {
    strokesRef.current = [];
    activeStrokeRef.current = null;
    drawingRef.current = false;
    activePointerIdRef.current = null;
    setHasInk(false);
    drawStrokes();
  };

  const undoStroke = () => {
    strokesRef.current.pop();
    setHasInk(strokesRef.current.length > 0);
    drawStrokes();
  };

  const handleSignaturePhoto = async (file) => {
    setError('');
    setSourcePhotoDataUrl('');
    setExtractedSignatureDataUrl('');
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 12 * 1024 * 1024) {
      setError('Choose a JPEG or PNG photo smaller than 12 MB. The image will be compressed securely before upload.');
      return;
    }
    setPhotoProcessing(true);
    try {
      const sourceDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Unable to read the selected photograph.'));
        reader.readAsDataURL(file);
      });
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('The selected photograph could not be opened.'));
        element.src = sourceDataUrl;
      });
      const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      sourceContext.fillStyle = '#ffffff';
      sourceContext.fillRect(0, 0, width, height);
      sourceContext.drawImage(image, 0, 0, width, height);
      const compressedPhoto = sourceCanvas.toDataURL('image/jpeg', 0.68);
      if (compressedPhoto.length > 2_000_000) {
        throw new Error('This photo is still too large. Please crop closer to the signature and try again.');
      }

      const pixels = sourceContext.getImageData(0, 0, width, height);
      let minX = width, minY = height, maxX = -1, maxY = -1, inkPixels = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          const luminance = 0.299 * pixels.data[index] + 0.587 * pixels.data[index + 1] + 0.114 * pixels.data[index + 2];
          if (luminance < 155) {
            inkPixels += 1;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
          }
        }
      }
      if (inkPixels < 18 || maxX < minX || maxY < minY) {
        throw new Error('No clear handwritten signature was detected. Use a closer photo with dark ink on plain white paper.');
      }
      const padding = 24;
      minX = Math.max(0, minX - padding); minY = Math.max(0, minY - padding);
      maxX = Math.min(width - 1, maxX + padding); maxY = Math.min(height - 1, maxY + padding);
      const cropWidth = maxX - minX + 1;
      const cropHeight = maxY - minY + 1;
      if (cropHeight > 1100 || cropWidth > 3000) {
        throw new Error('The detected signature area is too large. Crop the photograph closer to the signature and upload again.');
      }
      const output = document.createElement('canvas');
      output.width = cropWidth;
      output.height = cropHeight;
      const outputContext = output.getContext('2d');
      const cropped = sourceContext.getImageData(minX, minY, cropWidth, cropHeight);
      for (let i = 0; i < cropped.data.length; i += 4) {
        const luminance = 0.299 * cropped.data[i] + 0.587 * cropped.data[i + 1] + 0.114 * cropped.data[i + 2];
        const alpha = Math.max(0, Math.min(255, Math.round((190 - luminance) * 3.2)));
        cropped.data[i] = 20; cropped.data[i + 1] = 20; cropped.data[i + 2] = 20; cropped.data[i + 3] = alpha;
      }
      outputContext.putImageData(cropped, 0, 0);
      const extracted = output.toDataURL('image/png');
      if (extracted.length > 2_600_000) {
        throw new Error('The extracted signature image is too large. Please use a smaller, closer photograph.');
      }
      setSourcePhotoDataUrl(compressedPhoto);
      setExtractedSignatureDataUrl(extracted);
      setHasInk(true);
    } catch (photoError) {
      setError(photoError.message || 'Unable to extract the signature from this photograph.');
    } finally {
      setPhotoProcessing(false);
    }
  };

  const loadSignatureEvidence = async () => {
    if (!lease?.id) return;
    setEvidenceLoading(true);
    setError('');
    try {
      const data = await requestJson(`/api/leases/${encodeURIComponent(lease.id)}/signing/evidence`);
      setEvidenceUrl(data.url || '');
    } catch (evidenceError) {
      setError(evidenceError.message || 'No original signature photograph is available.');
    } finally {
      setEvidenceLoading(false);
    }
  };

  const saveSignature = async () => {
    const photoMode = isTenantFlow && signatureMethod === 'photo';
    const signatureDataUrl = photoMode ? extractedSignatureDataUrl : canvasRef.current?.toDataURL('image/png');
    if (!signatureDataUrl || (!photoMode && !strokesRef.current.length) || !session?.id) {
      setError(photoMode ? 'Upload a clear photo and review the extracted signature first.' : 'Please write the signature before continuing.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const signatureEndpoint = isTenantFlow
        ? `/api/public/qr/${encodeURIComponent(unitNumber)}/lease-signing/${encodeURIComponent(session.id)}/signature`
        : `/api/leases/${encodeURIComponent(lease.id)}/signing/${encodeURIComponent(session.id)}/signature`;
      const body = { signerType, signatureDataUrl, confirmed: true };
      if (photoMode && sourcePhotoDataUrl) body.signatureSourceDataUrl = sourcePhotoDataUrl;
      const data = await requestJson(signatureEndpoint, {
        method: 'POST',
        headers: isTenantFlow ? { Authorization: `Bearer ${tenantAccessToken}` } : {},
        body,
      });
      setSession(data.session || null);
      clearSignature();
      setSourcePhotoDataUrl('');
      setExtractedSignatureDataUrl('');
      setSignatureMethod('draw');
      setConfirmed(false);
      if (data.session?.status === 'signed') onCompleted?.();
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

      {!loading && !session && isTenantFlow ? (
        <div role="status" className="empty-state">
          <p>Management has not prepared this lease for signing yet. Please contact the property manager.</p>
          <button className="small-btn" type="button" onClick={refreshSigningStatus} disabled={loading}>Check again</button>
        </div>
      ) : null}
      {!loading && isTenantFlow && session?.status === 'awaiting_manager' ? (
        <div role="status" className="empty-state">
          <h4>Tenant signature received</h4>
          <p>Your handwritten signature has been securely recorded. The manager must now sign to complete the lease.</p>
          <p className="muted">Tenant signed: {session.tenantSignedAt ? new Date(session.tenantSignedAt).toLocaleString() : '—'}</p>
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
            {!isTenantFlow && session.tenantSignedAt ? (
              <div style={{ marginTop: '8px' }}>
                <button className="small-btn" type="button" onClick={loadSignatureEvidence} disabled={evidenceLoading}>
                  {evidenceLoading ? 'Loading source photo…' : 'View original paper-signature photo'}
                </button>
                {evidenceUrl ? <div style={{ marginTop: '10px' }}>
                  <img src={evidenceUrl} alt="Original tenant paper-signature photograph" style={{ maxWidth: '100%', maxHeight: '320px', border: '1px solid var(--border)', borderRadius: '8px' }} />
                  <p className="muted">Original source photograph retained privately for manager review. The extracted signature was generated from this same image.</p>
                </div> : null}
              </div>
            ) : null}
          </div>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            {signerType === 'tenant' ? 'Tenant signature' : 'Manager handwritten signature'}
          </label>
          {isTenantFlow ? (
            <div className="form-actions" style={{ marginBottom: '10px' }}>
              <button className={signatureMethod === 'draw' ? 'primary-btn' : 'small-btn'} type="button" onClick={() => { setSignatureMethod('draw'); setError(''); }}>Draw signature</button>
              <button className={signatureMethod === 'photo' ? 'primary-btn' : 'small-btn'} type="button" onClick={() => { setSignatureMethod('photo'); clearSignature(); setError(''); }}>Upload signed paper photo</button>
            </div>
          ) : null}
          {isTenantFlow && signatureMethod === 'photo' ? (
            <div className="panel" style={{ marginBottom: '12px' }}>
              <p>Take a clear photo of the handwritten signature on plain white paper. Frame the photo close around the signature, with dark ink and good lighting.</p>
              <label style={{ display: 'block' }}>
                Photograph or choose signed paper
                <input type="file" accept="image/jpeg,image/png" capture="environment" onChange={(event) => handleSignaturePhoto(event.target.files?.[0])} disabled={photoProcessing || saving} />
              </label>
              {photoProcessing ? <p role="status">Preparing and extracting the signature…</p> : null}
              {sourcePhotoDataUrl ? (
                <div className="form-grid" style={{ marginTop: '12px' }}>
                  <div>
                    <strong>Original photo</strong>
                    <img src={sourcePhotoDataUrl} alt="Original photograph of the handwritten signature" style={{ display: 'block', maxWidth: '100%', maxHeight: '260px', objectFit: 'contain', marginTop: '8px' }} />
                  </div>
                  <div>
                    <strong>Extracted electronic signature</strong>
                    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
                      <img src={extractedSignatureDataUrl} alt="Signature extracted from the uploaded photograph" style={{ display: 'block', maxWidth: '100%', maxHeight: '180px', objectFit: 'contain' }} />
                    </div>
                  </div>
                </div>
              ) : null}
              <p className="muted">Riiroow extracts the dark handwritten marks from the same uploaded image and retains the original privately for manager review. This checks the source of the extracted image, not the signer's identity or authorship.</p>
            </div>
          ) : null}
          {(!isTenantFlow || signatureMethod === 'draw') ? (
          <>
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
          </>
          ) : null}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', margin: '12px 0' }}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>
              {signerType === 'tenant'
                ? 'The tenant confirms that they reviewed this lease and are signing it voluntarily.'
                : 'I confirm that I am the authorized manager and approve this lease for signing.'}
            </span>
          </label>
          <button className="primary-btn" type="button" onClick={saveSignature} disabled={!confirmed || saving || photoProcessing || (isTenantFlow && signatureMethod === 'photo' ? !extractedSignatureDataUrl : !hasInk)}>
            {saving ? 'Saving signature…' : signerType === 'tenant' ? 'Confirm tenant signature' : 'Confirm manager signature'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
