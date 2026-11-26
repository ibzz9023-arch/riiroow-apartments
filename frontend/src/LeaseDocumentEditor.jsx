import React, { useEffect, useState } from 'react';

const emptyText = { page: '1', x: '55', y: '700', fontSize: '12', coverWidth: '220', coverHeight: '40', text: '', cover: true };
const emptyImage = { page: '1', x: '55', y: '600', width: '120', height: '60' };

export default function LeaseDocumentEditor({ lease, document, requestJson, requestPdf, requestDocumentDownload, onClose, onSaved }) {
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState('');
  const [originalPreviewError, setOriginalPreviewError] = useState('');
  const [textDraft, setTextDraft] = useState(emptyText);
  const [imageDraft, setImageDraft] = useState(emptyImage);
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [textItems, setTextItems] = useState([]);
  const [images, setImages] = useState([]);
  const [deletePages, setDeletePages] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewFingerprint, setPreviewFingerprint] = useState('');
  const [error, setError] = useState('');
  const isSignedSource = document.documentType === 'signed_lease' || String(document.originalName || '').includes('EDITED_COPY_NOT_EXECUTED');

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setOriginalPreviewUrl('');
    setOriginalPreviewError('');

    const loadOriginalPdf = async () => {
      try {
        const blob = await requestDocumentDownload(document.previewUrl);
        if (!(blob instanceof Blob) || !blob.size || !blob.type.includes('pdf')) {
          throw new Error('The server did not return a valid PDF preview.');
        }
        objectUrl = URL.createObjectURL(blob);
        if (active) setOriginalPreviewUrl(objectUrl);
      } catch (loadError) {
        if (active) setOriginalPreviewError(loadError.message || 'Unable to load the original PDF preview.');
      }
    };

    loadOriginalPdf();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document.id, document.previewUrl]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const addText = () => {
    const page = Number(textDraft.page);
    const x = Number(textDraft.x);
    const y = Number(textDraft.y);
    const fontSize = Number(textDraft.fontSize);
    const coverWidth = Number(textDraft.coverWidth);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0 ||
        !Number.isFinite(fontSize) || fontSize < 6 || fontSize > 48 || !textDraft.text.trim() ||
        (textDraft.cover && (!Number.isFinite(coverWidth) || coverWidth < 20 || coverWidth > 500 || !Number.isFinite(Number(textDraft.coverHeight)) || Number(textDraft.coverHeight) < fontSize + 8 || Number(textDraft.coverHeight) > 500))) {
      setError('Enter a valid page, position, font size and replacement text.');
      return;
    }
    setTextItems((items) => [...items, {
      pageIndex: page - 1, x, y, fontSize, text: textDraft.text.trim(),
      cover: Boolean(textDraft.cover), coverWidth: textDraft.cover ? coverWidth : undefined, coverHeight: textDraft.cover ? Number(textDraft.coverHeight) : undefined,
    }]);
    setTextDraft({ ...emptyText, page: textDraft.page });
    setError('');
  };

  const handleImage = async (file) => {
    setImageDataUrl('');
    setImageName('');
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 1 * 1024 * 1024) {
      setError('Choose a PNG or JPEG image no larger than 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(String(reader.result || ''));
      setImageName(file.name);
      setError('');
    };
    reader.onerror = () => setError('The selected image could not be read.');
    reader.readAsDataURL(file);
  };

  const addImage = () => {
    if (images.length >= 3) { setError('Add no more than three images per PDF edit.'); return; }
    const page = Number(imageDraft.page);
    const x = Number(imageDraft.x);
    const y = Number(imageDraft.y);
    const width = Number(imageDraft.width);
    const height = Number(imageDraft.height);
    if (!imageDataUrl || !Number.isInteger(page) || page < 1 ||
        ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 10 || height < 10 || width > 500 || height > 500) {
      setError('Choose a valid image and enter its page and position.');
      return;
    }
    setImages((items) => [...items, { pageIndex: page - 1, x, y, width, height, dataUrl: imageDataUrl, name: imageName }]);
    setImageDataUrl('');
    setImageName('');
    setError('');
  };

  const parsedDeletePages = () => {
    if (!deletePages.trim()) return [];
    const values = deletePages.split(',').map((part) => part.trim());
    if (values.some((part) => !/^\d+$/.test(part) || Number(part) < 1)) {
      throw new Error('Enter page numbers to remove as a comma-separated list, for example 2,4.');
    }
    return [...new Set(values.map((part) => Number(part) - 1))];
  };

  const buildPayload = () => ({
    textItems,
    images: images.map(({ name, ...image }) => image),
    deletePageIndices: parsedDeletePages(),
  });

  const preview = async () => {
    if (previewBusy || (!textItems.length && !images.length && !deletePages.trim())) return;
    setPreviewBusy(true);
    setError('');
    try {
      const payload = buildPayload();
      const blob = await requestPdf(
        `/api/leases/${encodeURIComponent(lease.id)}/documents/${encodeURIComponent(document.id)}/preview-edit`,
        payload
      );
      if (!(blob instanceof Blob) || !blob.size) throw new Error('The preview returned an empty PDF.');
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewFingerprint(JSON.stringify(payload));
    } catch (previewError) {
      setError(previewError.message || 'Unable to preview the PDF changes.');
    } finally {
      setPreviewBusy(false);
    }
  };

  const save = async () => {
    if (saving || (!textItems.length && !images.length && !deletePages.trim())) return;
    let payload;
    try {
      payload = buildPayload();
    } catch (parseError) {
      setError(parseError.message);
      return;
    }
    if (previewFingerprint !== JSON.stringify(payload)) {
      setError('Preview the latest changes before saving the corrected PDF.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await requestJson(
        `/api/leases/${encodeURIComponent(lease.id)}/documents/${encodeURIComponent(document.id)}/edit-pdf`,
        { method: 'POST', body: payload }
      );
      onSaved?.(result);
    } catch (saveError) {
      setError(saveError.message || 'Unable to save the edited PDF.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel lease-document-editor" aria-label="Lease PDF editor">
      <div className="panel-header">
        <div>
          <h3>Direct PDF editor</h3>
          <p className="muted">{document.originalName}</p>
        </div>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>Close editor</button>
      </div>
      <div className="notice warning">
        This editor adds replacement text over a white cover, inserts images and removes pages. It does not rewrite or reflow embedded PDF text like Microsoft Word. For full clause editing, use the separate Word-style lease editor. A signed source is watermarked as an edited copy; its original signatures do not authorize changed terms.
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="lease-editor-preview">
        {originalPreviewError && !previewUrl ? <p className="error-text" role="alert">{originalPreviewError}</p> : null}
        {!previewUrl && !originalPreviewUrl && !originalPreviewError ? <p className="muted">Loading original PDF preview…</p> : null}
        {(previewUrl || originalPreviewUrl) ? (
          <iframe title={previewUrl ? "Corrected PDF preview" : "Original PDF preview"} src={previewUrl || originalPreviewUrl} />
        ) : null}
      </div>
      <p className="muted">Coordinates are PDF points measured from the bottom-left corner of the selected page. Use the PDF preview above to identify the page and approximate position.</p>
      <div className="panel">
        <h4>Cover and replace text</h4>
        <div className="form-grid">
          <label>Page number (starting at 1)<input type="number" min="1" value={textDraft.page} onChange={(event) => setTextDraft((v) => ({ ...v, page: event.target.value }))} /></label>
          <label>Left position (pt)<input type="number" min="0" value={textDraft.x} onChange={(event) => setTextDraft((v) => ({ ...v, x: event.target.value }))} /></label>
          <label>Bottom position (pt)<input type="number" min="0" value={textDraft.y} onChange={(event) => setTextDraft((v) => ({ ...v, y: event.target.value }))} /></label>
          <label>Font size<input type="number" min="6" max="48" value={textDraft.fontSize} onChange={(event) => setTextDraft((v) => ({ ...v, fontSize: event.target.value }))} /></label>
          <label className="full-span">Replacement text<textarea rows="3" maxLength={2000} value={textDraft.text} onChange={(event) => setTextDraft((v) => ({ ...v, text: event.target.value }))} placeholder="Enter the text to place on the page" /></label>
          <label>White cover width (pt)<input type="number" min="20" max="500" value={textDraft.coverWidth} disabled={!textDraft.cover} onChange={(event) => setTextDraft((v) => ({ ...v, coverWidth: event.target.value }))} /></label>
          <label>White cover height (pt)<input type="number" min="20" max="500" value={textDraft.coverHeight} disabled={!textDraft.cover} onChange={(event) => setTextDraft((v) => ({ ...v, coverHeight: event.target.value }))} /></label>
          <label className="lease-editor-check"><input type="checkbox" checked={textDraft.cover} onChange={(event) => setTextDraft((v) => ({ ...v, cover: event.target.checked }))} /> Cover old text first</label>
        </div>
        <button type="button" className="small-btn" onClick={addText}>Add text change</button>
        {textItems.map((item, index) => (
          <div className="lease-editor-change" key={index}>
            <span>Page {item.pageIndex + 1}: {item.text}</span>
            <button type="button" className="small-btn danger" onClick={() => setTextItems((items) => items.filter((_, i) => i !== index))}>Remove</button>
          </div>
        ))}
      </div>
      {!isSignedSource ? (
        <div className="panel">
          <h4>Insert image</h4>
          <div className="form-grid">
            <label className="full-span">PNG/JPEG image (max 1 MB)<input type="file" accept="image/png,image/jpeg" onChange={(event) => handleImage(event.target.files?.[0])} /></label>
            <label>Page number<input type="number" min="1" value={imageDraft.page} onChange={(event) => setImageDraft((v) => ({ ...v, page: event.target.value }))} /></label>
            <label>Left position (pt)<input type="number" min="0" value={imageDraft.x} onChange={(event) => setImageDraft((v) => ({ ...v, x: event.target.value }))} /></label>
            <label>Bottom position (pt)<input type="number" min="0" value={imageDraft.y} onChange={(event) => setImageDraft((v) => ({ ...v, y: event.target.value }))} /></label>
            <label>Width (pt)<input type="number" min="10" max="500" value={imageDraft.width} onChange={(event) => setImageDraft((v) => ({ ...v, width: event.target.value }))} /></label>
            <label>Height (pt)<input type="number" min="10" max="500" value={imageDraft.height} onChange={(event) => setImageDraft((v) => ({ ...v, height: event.target.value }))} /></label>
          </div>
          {imageName ? <p className="muted">Selected: {imageName}</p> : null}
          <button type="button" className="small-btn" disabled={!imageDataUrl} onClick={addImage}>Add image</button>
          {images.map((item, index) => (
            <div className="lease-editor-change" key={index}>
              <span>Page {item.pageIndex + 1}: {item.name}</span>
              <button type="button" className="small-btn danger" onClick={() => setImages((items) => items.filter((_, i) => i !== index))}>Remove</button>
            </div>
          ))}
        </div>
  
      ) : (
        <div className="panel">
          <h4>Image insertion unavailable</h4>
          <p className="muted">Images, including signature pictures, cannot be pasted into a previously signed lease. Use Smart Lease Signing to capture fresh signatures on a new lease version.</p>
        </div>
      )}
      <div className="panel">
        <h4>Page management</h4>
        <label>Remove page numbers (comma-separated, e.g. 2,4)<input value={deletePages} onChange={(event) => setDeletePages(event.target.value)} placeholder="Leave blank to keep all pages" /></label>
        <p className="muted">At least one page must remain. Page reordering is not supported in this editor.</p>
      </div>
      <div className="form-actions">
        <button type="button" className="secondary-btn" disabled={previewBusy || (!textItems.length && !images.length && !deletePages.trim())} onClick={preview}>{previewBusy ? 'Preparing preview…' : 'Preview changes'}</button>
        <button type="button" className="primary-btn" disabled={saving || previewFingerprint !== JSON.stringify({ textItems, images: images.map(({ name, ...image }) => image), deletePageIndices: (() => { try { return parsedDeletePages(); } catch { return []; } })() }) || (!textItems.length && !images.length && !deletePages.trim())} onClick={save}>{saving ? 'Saving new PDF copy…' : 'Save as separate edited PDF'}</button>
      </div>
    </section>
  );
}
