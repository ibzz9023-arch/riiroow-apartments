import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument, StandardFonts, rgb } from 'pdf-lib';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ITEMS = 100;
const MAX_IMAGES = 3;
const safeNumber = (value, min, max, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw Object.assign(new Error(`${label} is outside the allowed range.`), { statusCode: 400 });
  }
  return number;
};
const safePageIndex = (value, pageCount, label) => {
  const index = safeNumber(value, 0, pageCount - 1, label);
  if (!Number.isInteger(index)) {
    throw Object.assign(new Error(`${label} must be a whole page number.`), { statusCode: 400 });
  }
  return index;
};

export const editLeasePdf = async ({ sourcePdf, textItems = [], images = [], deletePageIndices = [], isSignedSource = false }) => {
  if (!Buffer.isBuffer(sourcePdf) || sourcePdf.length < 8 || sourcePdf.length > MAX_PDF_BYTES || sourcePdf.subarray(0, 5).toString() !== '%PDF-') {
    throw Object.assign(new Error('The source document is not a valid PDF under 10 MB.'), { statusCode: 400 });
  }
  if (!Array.isArray(textItems) || textItems.length > MAX_TEXT_ITEMS || !Array.isArray(images) || images.length > MAX_IMAGES || !Array.isArray(deletePageIndices) || deletePageIndices.length > 100) {
    throw Object.assign(new Error('The PDF edit contains too many changes.'), { statusCode: 400 });
  }
  if (isSignedSource && images.length) {
    throw Object.assign(new Error('Images and signature pictures cannot be inserted into a previously signed lease copy. Use Smart Lease Signing to capture fresh signatures on a new lease version.'), { statusCode: 400 });
  }
  if (isSignedSource && images.length) {
    throw Object.assign(new Error('Images and signature pictures cannot be inserted into an already signed lease. Start a new signing version instead.'), { statusCode: 400 });
  }
  const pdf = await PdfLibDocument.load(sourcePdf, { updateMetadata: false });
  const pages = pdf.getPages();
  if (!pages.length) throw Object.assign(new Error('The PDF has no pages.'), { statusCode: 400 });
  const deleted = new Set(deletePageIndices.map((value) => safePageIndex(value, pages.length, 'Page index')));
  if (deleted.size >= pages.length) throw Object.assign(new Error('At least one PDF page must remain.'), { statusCode: 400 });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const item of textItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('Each text edit must be a valid object.'), { statusCode: 400 });
    }
    const pageIndex = safePageIndex(item.pageIndex, pages.length, 'Page number');
    if (deleted.has(pageIndex)) throw Object.assign(new Error('Text cannot be added to a page being removed.'), { statusCode: 400 });
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const size = safeNumber(item.fontSize ?? 12, 6, 48, 'Text size');
    const x = safeNumber(item.x, 0, width, 'Text X position');
    const y = safeNumber(item.y, size, height - size, 'Text Y position');
    const text = String(item.text || '').trim().slice(0, 2000);
    if (!text) continue;
    const coverWidth = item.cover === true ? safeNumber(item.coverWidth ?? 220, 20, Math.min(500, width - x), 'Cover width') : 0;
    const coverHeight = coverWidth ? safeNumber(item.coverHeight ?? size + 8, size + 8, Math.min(500, height - (y - size - 3)), 'Cover height') : 0;
    if (coverWidth) page.drawRectangle({ x, y: y - size - 3, width: coverWidth, height: coverHeight, color: rgb(1, 1, 1) });
    page.drawText(text, { x, y, size, font, color: rgb(0.05, 0.05, 0.05), maxWidth: Math.max(20, width - x - 12) });
  }
  for (const item of images) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('Each image edit must be a valid object.'), { statusCode: 400 });
    }
    const pageIndex = safePageIndex(item.pageIndex, pages.length, 'Image page number');
    if (deleted.has(pageIndex)) throw Object.assign(new Error('An image cannot be added to a page being removed.'), { statusCode: 400 });
    const dataUrl = String(item.dataUrl || '');
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw Object.assign(new Error('Images must be PNG or JPEG data.'), { statusCode: 400 });
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 1 * 1024 * 1024 || bytes.toString('base64') !== match[2]) {
      throw Object.assign(new Error('Each inserted image must be valid and no larger than 1 MB.'), { statusCode: 400 });
    }
    const image = match[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const x = safeNumber(item.x, 0, width, 'Image X position');
    const y = safeNumber(item.y, 0, height, 'Image Y position');
    const targetWidth = safeNumber(item.width, 10, Math.min(500, width - x), 'Image width');
    const targetHeight = safeNumber(item.height, 10, Math.min(500, height - y), 'Image height');
    page.drawImage(image, { x, y, width: targetWidth, height: targetHeight });
  }
  if (isSignedSource) {
    for (const page of pages) {
      const { width, height } = page.getSize();
      page.drawText('EDITED COPY — ORIGINAL SIGNATURES DO NOT AUTHORIZE CHANGED TERMS', {
        x: 24, y: height / 2, size: 12, font, color: rgb(0.72, 0.12, 0.12), opacity: 0.55,
        rotate: { type: 'degrees', angle: 32 }, maxWidth: Math.max(100, width - 48),
      });
    }
  }
  [...deleted].sort((a, b) => b - a).forEach((index) => pdf.removePage(index));
  const output = Buffer.from(await pdf.save({ useObjectStreams: true }));
  if (output.length > MAX_PDF_BYTES) throw Object.assign(new Error('The edited PDF exceeds the 10 MB archive limit.'), { statusCode: 413 });
  return output;
};

export const createCorrectedLeaseDraftPdf = ({ lease, tenant, clauses }) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 55, left: 52, right: 52 }, bufferPages: true,
    info: { Title: 'Corrected Lease Draft', Author: 'Riiroow Apartments', Subject: 'Unexecuted corrected lease draft' } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('error', reject);
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  const line = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(10).text(label + ': ', { continued: true });
    doc.font('Helvetica').text(String(value ?? '—'));
    doc.moveDown(0.45);
  };
  doc.font('Helvetica-Bold').fontSize(17).text('RIIROOW APARTMENTS', { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(13).text('RESIDENTIAL LEASE AGREEMENT', { align: 'center' });
  doc.moveDown(0.6);
  doc.fillColor('#a16207').font('Helvetica-Bold').fontSize(11).text('CORRECTED DRAFT — REQUIRES REVIEW AND RE-SIGNING', { align: 'center' });
  doc.fillColor('#222222').moveDown(0.8);
  line('Tenant', tenant?.name || '—');
  line('Unit', lease.unit_number ?? lease.unitNumber ?? '—');
  line('Commencement date', lease.start_date ?? lease.startDate ?? '—');
  line('Expiry date', lease.end_date ?? lease.endDate ?? '—');
  line('Monthly rent', lease.monthly_rent ?? lease.monthlyRent ?? '—');
  line('Security deposit', lease.security_deposit ?? lease.securityDeposit ?? '—');
  doc.moveDown(0.4);
  for (const [index, clause] of clauses.entries()) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#222222').text(String(clause.title || `CLAUSE ${index + 1}`), { paragraphGap: 4 });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333333').text(String(clause.body || ''), { align: 'justify', paragraphGap: 8 });
    doc.moveDown(0.35);
  }
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#a16207').text('This draft is not an executed agreement. Both parties must review and sign the corrected version before it replaces any existing agreement.');
  if (doc.y > doc.page.height - 170) doc.addPage();
  doc.moveDown(1.2);
  doc.fillColor('#222222').font('Helvetica-Bold').fontSize(11).text('SIGNATURES');
  doc.moveDown(1);
  const signatureY = doc.y + 22;
  const columnWidth = 235;
  const rightX = 310;
  [52, rightX].forEach((x) => doc.moveTo(x, signatureY).lineTo(x + columnWidth, signatureY).strokeColor('#222222').lineWidth(0.8).stroke());
  doc.font('Helvetica-Bold').fontSize(9).text('Tenant signature', 52, signatureY + 7, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).text('Riiroow Apartments Management', rightX, signatureY + 7, { width: columnWidth, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text('Name: ' + String(tenant?.name || '—'), 52, signatureY + 42, { width: columnWidth, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text('Name: Authorized Manager', rightX, signatureY + 42, { width: columnWidth, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text('Date: __________________', 52, signatureY + 64, { width: columnWidth, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text('Date: __________________', rightX, signatureY + 64, { width: columnWidth, lineBreak: false });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#777777')
      .text('Corrected draft — unsigned · Riiroow Apartments', 52, 805, { width: 491, align: 'center', lineBreak: false });
  }
  doc.end();
});
