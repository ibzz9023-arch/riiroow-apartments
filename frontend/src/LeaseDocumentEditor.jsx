import React, { useEffect, useMemo, useState } from 'react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const wrapText = (text, font, size, maxWidth) => {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? line + ' ' + word : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  });
  if (line) lines.push(line);
  return lines;
};

export default function LeaseDocumentEditor({ lease, document, requestJson, onClose, onSaved }) {
  const [sourcePdf, setSourcePdf] = useState(null);
  const [pageOrder, setPageOrder] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState('Cosmetic correction');
  const [mask, setMask] = useState({ x: 60, y: 80, width: 220, height: 34 });
  const [replacement, setReplacement] = useState('');
  const [fontSize, setFontSize] = useState(11);
  const [imageFile, setImageFile] = useState(null);
  const [imagePosition, setImagePosition] = useState({ x: 60, y: 140, width: 140, height: 70 });
  const [operations, setOperations] = useState([]);
  const [termsChanged, setTermsChanged] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    fetch(document.previewUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then((response) => {
        if (!response.ok) throw new Error('The source PDF could not be downloaded for editing.');
        return response.arrayBuffer();
      })
      .then(async (bytes) => {
        if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('The source PDF exceeds the 10 MB editing limit.');
        const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
        if (!loaded.getPageCount()) throw new Error('This PDF has no editable pages.');
        if (active) {
          setSourcePdf(loaded);
          setPageOrder(loaded.getPages().map((_, index) => index));
          setPageIndex(0);
        }
      })
      .catch((loadError) => { if (active) setError(loadError.message || 'Unable to open this PDF.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [document.id, document.previewUrl]);

  const currentPageNumber = pageOrder[pageIndex];
  const currentPage = sourcePdf && Number.isInteger(currentPageNumber) ? sourcePdf.getPage(currentPageNumber) : null;
  const dimensions = currentPage ? currentPage.getSize() : { width: 0, height: 0 };
  const currentOperations = useMemo(
    () => operations.filter((operation) => operation.page === currentPageNumber),
    [operations, currentPageNumber]
  );

  const addTextCorrection = () => {
    if (!replacement.trim()) {
      setError('Enter the replacement text before adding it.');
      return;
    }
    setOperations((items) => [...items, {
      id: crypto.randomUUID(),
      type: 'text',
      page: currentPageNumber,
      ...mask,
      text: replacement.trim(),
      fontSize: Math.max(6, Math.min(28, Number(fontSize) || 11)),
    }]);
    setReplacement('');
    setError('');
  };

  const addImageCorrection = async () => {
    if (!imageFile) return;
    if (imageFile.size > MAX_IMAGE_BYTES) {
      setError('Images must not exceed 5 MB.');
      return;
    }
    const bytes = await imageFile.arrayBuffer();
    const isPng = imageFile.type === 'image/png';
    const isJpg = imageFile.type === 'image/jpeg';
    if (!isPng && !isJpg) {
      setError('Only PNG and JPEG images can be inserted.');
      return;
    }
    setOperations((items) => [...items, {
      id: crypto.randomUUID(),
      type: 'image',
      page: currentPageNumber,
      bytes: Array.from(new Uint8Array(bytes)),
      imageType: isPng ? 'png' : 'jpg',
      ...imagePosition,
    }]);
    setImageFile(null);
    setError('');
  };

  const movePage = (direction) => {
    const target = pageIndex + direction;
    if (target < 0 || target >= pageOrder.length) return;
    setPageOrder((items) => {
      const next = [...items];
      [next[pageIndex], next[target]] = [next[target], next[pageIndex]];
      return next;
    });
    setPageIndex(target);
  };

  const deletePage = () => {
    if (pageOrder.length <= 1) {
      setError('A corrected PDF must contain at least one page.');
      return;
    }
    const removed = currentPageNumber;
    setPageOrder((items) => items.filter((index) => index !== removed));
    setOperations((items) => items.filter((operation) => operation.page !== removed));
    setPageIndex((index) => Math.max(0, Math.min(index, pageOrder.length - 2)));
    setError('');
  };

  const removeOperation = (id) => setOperations((items) => items.filter((item) => item.id !== id));

  const saveCorrection = async () => {
    if (!sourcePdf || !pageOrder.length || saving) return;
    if (!summary.trim()) {
      setError('Enter a short correction reason.');
      return;
    }
    if (termsChanged && !window.confirm('You marked this as a change to lease terms. This copy will be labelled NOT RE-SIGNED. Both tenant and manager must sign a new version before the changed terms are treated as agreed. Continue?')) return;
    setSaving(true);
    setError('');
    try {
      const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
      for (const operation of operations) {
        const page = sourcePdf.getPage(operation.page);
        const pageHeight = page.getHeight();
        const top = Math.max(0, Number(operation.y) || 0);
        const height = Math.max(8, Number(operation.height) || 20);
        const x = Math.max(0, Number(operation.x) || 0);
        const width = Math.max(12, Number(operation.width) || 100);
        if (operation.type === 'text') {
          page.drawRectangle({
            x, y: pageHeight - top - height, width, height,
            color: rgb(1, 1, 1), borderWidth: 0,
          });
          const size = operation.fontSize || 11;
          const lines = wrapText(operation.text, font, size, Math.max(20, width - 8));
          lines.slice(0, Math.max(1, Math.floor((height - 6) / (size + 2)))).forEach((line, index) => {
            page.drawText(line, {
              x: x + 4,
              y: pageHeight - top - size - 4 - index * (size + 2),
              size,
              font,
              color: rgb(0.08, 0.08, 0.08),
            });
          });
        } else if (operation.type === 'image') {
          const imageBytes = Uint8Array.from(operation.bytes);
          const embedded = operation.imageType === 'png'
            ? await sourcePdf.embedPng(imageBytes)
            : await sourcePdf.embedJpg(imageBytes);
          page.drawImage(embedded, {
            x,
            y: pageHeight - top - height,
            width,
            height,
          });
        }
      }

      const pages = sourcePdf.getPages();
      pageOrder.forEach((originalIndex, orderIndex) => {
        const page = pages[originalIndex];
        const { width, height } = page.getSize();
        page.drawText('CORRECTED COPY — NOT RE-SIGNED', {
          x: Math.max(18, width - 230),
          y: height - 18,
          size: 8,
          font,
          color: rgb(0.72, 0.12, 0.12),
        });
      });

      const output = await PDFDocument.create();
      const orderedPages = await output.copyPages(sourcePdf, pageOrder);
      orderedPages.forEach((page) => output.addPage(page));
      output.setTitle('Corrected copy - not re-signed - ' + (document.originalName || 'Lease PDF'));
      output.setSubject('Correction reason: ' + summary.trim().slice(0, 300));
      output.setProducer('Riiroow Apartments Lease Document Editor');
      const bytes = await output.save();
      if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('The corrected PDF exceeds the 10 MB archive limit.');

      const formData = new FormData();
      formData.append('document', new Blob([bytes], { type: 'application/pdf' }), 'corrected-lease.pdf');
      formData.append('changeSummary', summary.trim().slice(0, 500));
      formData.append('termsChanged', termsChanged ? 'true' : 'false');
      const result = await requestJson(
        `/api/leases/${encodeURIComponent(lease.id)}/documents/${encodeURIComponent(document.id)}/corrections`,
        { method: 'POST', body: formData }
      );
      onSaved?.(result);
    } catch (saveError) {
      setError(saveError.message || 'Unable to save the corrected PDF.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel lease-document-editor" aria-label="Lease PDF editor">
      <div className="panel-header">
        <div>
          <h3>Edit PDF — {document.originalName}</h3>
          <p className="muted">Changes are saved as a new corrected copy. The original PDF is never overwritten.</p>
        </div>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>Close editor</button>
      </div>
      <div className="notice warning">
        This editor covers selected areas and places replacement text or images over the PDF. It does not reflow or rewrite the PDF's embedded text like Microsoft Word. Every saved page is marked “CORRECTED COPY — NOT RE-SIGNED”.
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {loading ? <p role="status">Opening PDF…</p> : null}
      {!loading && sourcePdf ? (
        <>
          <div className="lease-editor-toolbar">
            <button type="button" className="small-btn" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}>Previous page</button>
            <strong>Page {pageIndex + 1} of {pageOrder.length}</strong>
            <button type="button" className="small-btn" disabled={pageIndex >= pageOrder.length - 1} onClick={() => setPageIndex((value) => value + 1)}>Next page</button>
            <button type="button" className="small-btn" disabled={pageIndex === 0} onClick={() => movePage(-1)}>Move left</button>
            <button type="button" className="small-btn" disabled={pageIndex >= pageOrder.length - 1} onClick={() => movePage(1)}>Move right</button>
            <button type="button" className="small-btn danger" disabled={pageOrder.length <= 1} onClick={deletePage}>Delete page</button>
          </div>
          <div className="lease-editor-preview">
            <iframe title="Source PDF preview" src={document.previewUrl} />
          </div>
          <p className="muted">Current page size: {Math.round(dimensions.width)} × {Math.round(dimensions.height)} PDF points. Coordinates below are measured from the top-left corner of this page.</p>
          <div className="form-grid">
            <label>Left position (pt)<input type="number" min="0" value={mask.x} onChange={(event) => setMask((v) => ({ ...v, x: Number(event.target.value) }))} /></label>
            <label>Top position (pt)<input type="number" min="0" value={mask.y} onChange={(event) => setMask((v) => ({ ...v, y: Number(event.target.value) }))} /></label>
            <label>Cover width (pt)<input type="number" min="12" value={mask.width} onChange={(event) => setMask((v) => ({ ...v, width: Number(event.target.value) }))} /></label>
            <label>Cover height (pt)<input type="number" min="8" value={mask.height} onChange={(event) => setMask((v) => ({ ...v, height: Number(event.target.value) }))} /></label>
            <label className="full-span">Replacement text<textarea rows="3" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Type the corrected text to place over the selected area" /></label>
            <label>Font size<input type="number" min="6" max="28" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /></label>
            <div className="form-actions"><button type="button" className="small-btn" onClick={addTextCorrection}>Add text correction</button></div>
          </div>
          <div className="form-grid">
            <label className="full-span">Insert image (PNG/JPEG, max 5 MB)<input type="file" accept="image/png,image/jpeg" onChange={(event) => setImageFile(event.target.files?.[0] || null)} /></label>
            <label>Image left (pt)<input type="number" min="0" value={imagePosition.x} onChange={(event) => setImagePosition((v) => ({ ...v, x: Number(event.target.value) }))} /></label>
            <label>Image top (pt)<input type="number" min="0" value={imagePosition.y} onChange={(event) => setImagePosition((v) => ({ ...v, y: Number(event.target.value) }))} /></label>
            <label>Image width (pt)<input type="number" min="10" value={imagePosition.width} onChange={(event) => setImagePosition((v) => ({ ...v, width: Number(event.target.value) }))} /></label>
            <label>Image height (pt)<input type="number" min="10" value={imagePosition.height} onChange={(event) => setImagePosition((v) => ({ ...v, height: Number(event.target.value) }))} /></label>
            <div className="form-actions"><button type="button" className="small-btn" disabled={!imageFile} onClick={addImageCorrection}>Add image</button></div>
          </div>
          <div className="panel">
            <h4>Changes on this page</h4>
            {!currentOperations.length ? <p className="muted">No changes added to this page yet.</p> : currentOperations.map((operation) => (
              <div className="lease-editor-change" key={operation.id}>
                <span>{operation.type === 'text' ? `Text: ${operation.text}` : 'Image'} — {Math.round(operation.x)}, {Math.round(operation.y)}</span>
                <button type="button" className="small-btn danger" onClick={() => removeOperation(operation.id)}>Remove</button>
              </div>
            ))}
          </div>
          <div className="form-grid">
            <label className="full-span">Correction reason<input value={summary} maxLength={500} onChange={(event) => setSummary(event.target.value)} /></label>
            <label className="full-span lease-editor-check"><input type="checkbox" checked={termsChanged} onChange={(event) => setTermsChanged(event.target.checked)} /> This changes lease terms (rent, dates, parties, deposit, obligations or clauses). A new signing by both parties is required.</label>
          </div>
          <div className="form-actions">
            <button type="button" className="primary-btn" disabled={saving || !operations.length && pageOrder.length === sourcePdf.getPageCount()} onClick={saveCorrection}>{saving ? 'Saving corrected copy…' : 'Save as new corrected PDF'}</button>
            <span className="muted">Source: {document.originalName}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}
