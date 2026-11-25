import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { PDFDocument as PdfLibDocument, StandardFonts } from 'pdf-lib';
import { editLeasePdf, createCorrectedLeaseDraftPdf, createCorrectedLeaseDraftDocx } from '../src/leaseDocumentEditor.js';

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
    /cannot be inserted into a previously signed lease copy/
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

test('corrected lease draft generator produces a valid unsigned PDF from 16 clauses', async () => {
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
  assert.ok(pdfBytes.length > 1000);
  const parsed = await PdfLibDocument.load(pdfBytes);
  assert.ok(parsed.getPageCount() >= 1);
});


test('corrected lease Word export is a valid DOCX archive containing all 16 editable clauses', () => {
  const clauses = Array.from({ length: 16 }, (_, index) => ({
    title: 'Clause ' + (index + 1) + ' — Test',
    body: 'Clause ' + (index + 1) + ' wording & details.',
  }));
  const docx = createCorrectedLeaseDraftDocx({
    lease: { unit_number: '101', start_date: '2026-01-01', end_date: '2026-12-31', monthly_rent: 500, security_deposit: 500 },
    tenant: { name: 'Test Tenant' },
    clauses,
  });
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  let offset = 0;
  let documentXml = '';
  while (offset + 30 < docx.length && docx.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = docx.readUInt32LE(offset + 18);
    const nameLength = docx.readUInt16LE(offset + 26);
    const extraLength = docx.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = docx.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = docx.subarray(dataStart, dataStart + compressedSize);
    if (name === 'word/document.xml') documentXml = inflateRawSync(compressed).toString('utf8');
    offset = dataStart + compressedSize;
  }
  assert.ok(documentXml.includes('RIIROOW APARTMENTS'));
  assert.ok(documentXml.includes('Clause 1 — Test'));
  assert.ok(documentXml.includes('Clause 16 — Test'));
  assert.ok(documentXml.includes('Clause 3 wording &amp; details.'));
  assert.ok(documentXml.includes('SIGNATURES'));
});
