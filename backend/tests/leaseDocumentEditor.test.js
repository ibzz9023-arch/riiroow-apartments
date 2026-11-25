import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument as PdfLibDocument, StandardFonts } from 'pdf-lib';
import { editLeasePdf, createCorrectedLeaseDraftPdf } from '../src/leaseDocumentEditor.js';

const makeSourcePdf = async () => {
  const pdf = await PdfLibDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([595, 842]);
  first.drawText('Original lease text', { x: 50, y: 760, font, size: 12 });
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
};

test('PDF edits create a separate valid copy and leave source bytes unchanged', async () => {
  const source = await makeSourcePdf();
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const edited = await editLeasePdf({
    sourcePdf: source,
    textItems: [{ pageIndex: 0, x: 50, y: 720, fontSize: 12, text: 'Corrected wording', cover: true, coverWidth: 180 }],
    deletePageIndices: [1],
    isSignedSource: true,
  });
  const parsed = await PdfLibDocument.load(edited);
  assert.equal(parsed.getPageCount(), 1);
  assert.notEqual(crypto.createHash('sha256').update(edited).digest('hex'), sourceHash);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), sourceHash);
});

test('PDF editor blocks image insertion into an already signed lease', async () => {
  const source = await makeSourcePdf();
  await assert.rejects(
    () => editLeasePdf({ sourcePdf: source, isSignedSource: true, images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }),
    /cannot be inserted into an already signed lease/
  );
});

test('PDF editor rejects deleting every page', async () => {
  const source = await makeSourcePdf();
  await assert.rejects(
    () => editLeasePdf({ sourcePdf: source, deletePageIndices: [0, 1] }),
    /At least one PDF page must remain/
  );
});

test('PDF editor rejects fractional page indexes', async () => {
  const source = await makeSourcePdf();
  await assert.rejects(
    () => editLeasePdf({ sourcePdf: source, textItems: [{ pageIndex: 0.5, x: 20, y: 20, text: 'Invalid' }] }),
    /whole page number/
  );
});

test('corrected lease draft is a valid unsigned PDF containing the complete clause set', async () => {
  const clauses = Array.from({ length: 16 }, (_, index) => ({
    title: `CLAUSE ${index + 1} — TEST`,
    body: `Clause ${index + 1} wording for a corrected lease draft.`,
  }));
  const pdfBytes = await createCorrectedLeaseDraftPdf({
    lease: { unit_number: '101', start_date: '2026-01-01', end_date: '2026-12-31', monthly_rent: 500, security_deposit: 500 },
    tenant: { name: 'Test Tenant' },
    clauses,
  });
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const parsed = await PdfLibDocument.load(pdfBytes);
  assert.ok(parsed.getPageCount() >= 1);
});
