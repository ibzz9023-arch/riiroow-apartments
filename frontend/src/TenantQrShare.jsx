import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

export default function TenantQrShare({ unitNumber }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const unit = String(unitNumber ?? '').trim();
  const tenantUrl = useMemo(() => {
    if (!unit) return '';
    return new URL(`${import.meta.env.BASE_URL}qr/${encodeURIComponent(unit)}`, window.location.origin).toString();
  }, [unit]);

  useEffect(() => {
    let active = true;
    if (!tenantUrl) {
      setQrDataUrl('');
      return () => { active = false; };
    }
    QRCode.toDataURL(tenantUrl, { width: 320, margin: 2, errorCorrectionLevel: 'H' })
      .then((value) => { if (active) setQrDataUrl(value); })
      .catch(() => { if (active) setError('Unable to generate this unit QR code.'); });
    return () => { active = false; };
  }, [tenantUrl]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(tenantUrl);
      setError('');
      window.alert('Tenant QR link copied.');
    } catch {
      setError('Copy was blocked by the browser. You can select the link below and copy it.');
    }
  };

  const share = async () => {
    setSharing(true);
    setError('');
    try {
      if (navigator.share) {
        let files = [];
        if (qrDataUrl && typeof File !== 'undefined') {
          const response = await fetch(qrDataUrl);
          const blob = await response.blob();
          const file = new File([blob], `riiroow-unit-${unit}-qr.png`, { type: 'image/png' });
          if (navigator.canShare?.({ files: [file] })) files = [file];
        }
        await navigator.share({
          title: `Riiroow tenant portal — Unit ${unit}`,
          text: `Open the Riiroow tenant portal for Unit ${unit}. Verify your Tenant PIN to access services.`,
          url: tenantUrl,
          ...(files.length ? { files } : {}),
        });
      } else {
        await copyLink();
      }
    } catch (shareError) {
      if (shareError?.name !== 'AbortError') setError('Sharing was unavailable. Copy the tenant link instead.');
    } finally {
      setSharing(false);
    }
  };

  const downloadQr = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.href = qrDataUrl;
    link.download = `riiroow-unit-${unit}-qr.png`;
    link.click();
  };

  if (!unit) return null;
  return (
    <section className="panel" style={{ marginBottom: '14px' }}>
      <div className="panel-header">
        <div>
          <h4>Share tenant QR — Unit {unit}</h4>
          <p className="muted">Share this link with the tenant. Their private services remain protected by Tenant PIN verification.</p>
        </div>
      </div>
      {qrDataUrl ? <img src={qrDataUrl} alt={`Tenant portal QR code for Unit ${unit}`} style={{ display: 'block', width: '180px', height: '180px', objectFit: 'contain', margin: '0 auto 12px' }} /> : <p role="status">Generating QR code…</p>}
      <label style={{ display: 'block' }}>
        Tenant portal link
        <input type="url" readOnly value={tenantUrl} onFocus={(event) => event.target.select()} />
      </label>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button className="primary-btn" type="button" onClick={share} disabled={!qrDataUrl || sharing}>{sharing ? 'Opening share…' : 'Share QR / link'}</button>
        <button className="small-btn" type="button" onClick={copyLink}>Copy link</button>
        <button className="small-btn" type="button" onClick={downloadQr} disabled={!qrDataUrl}>Download QR</button>
      </div>
    </section>
  );
}
