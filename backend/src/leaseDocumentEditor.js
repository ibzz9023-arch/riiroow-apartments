import PDFDocument from 'pdfkit';
import { deflateRawSync } from 'node:zlib';
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
  let totalImageBytes = 0;
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
    totalImageBytes += bytes.length;
    if (!bytes.length || bytes.length > 1 * 1024 * 1024 || totalImageBytes > 3 * 1024 * 1024 || bytes.toString('base64') !== match[2]) {
      throw Object.assign(new Error('Images must each be valid and no larger than 1 MB, with a combined limit of 3 MB.'), { statusCode: 400 });
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


const xmlEscape = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const createDocxZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosDate = 0x0021;
  for (const [name, source] of Object.entries(files)) {
    const filename = Buffer.from(name, 'utf8');
    const data = Buffer.from(source, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const docxParagraph = (text, style = 'Normal') =>
  '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr><w:r><w:t xml:space="preserve">' +
  xmlEscape(text) + '</w:t></w:r></w:p>';

export const createCorrectedLeaseDraftDocx = ({ lease, tenant, clauses }) => {
  if (!Array.isArray(clauses) || clauses.length !== 16) {
    throw Object.assign(new Error('A Word lease export must contain all 16 clauses.'), { statusCode: 400 });
  }
  const paragraphs = [
    docxParagraph('RIIROOW APARTMENTS', 'Title'),
    docxParagraph('RESIDENTIAL LEASE AGREEMENT', 'Subtitle'),
    docxParagraph('CORRECTED DRAFT — REQUIRES REVIEW AND RE-SIGNING', 'Warning'),
    docxParagraph('Tenant: ' + (tenant?.name || '—')),
    docxParagraph('Unit number: ' + (lease.unit_number ?? lease.unitNumber ?? '—')),
    docxParagraph('Commencement date: ' + (lease.start_date ?? lease.startDate ?? '—')),
    docxParagraph('Expiry date: ' + (lease.end_date ?? lease.endDate ?? '—')),
    docxParagraph('Monthly rent (USD): ' + (lease.monthly_rent ?? lease.monthlyRent ?? '—')),
    docxParagraph('Security deposit (USD): ' + (lease.security_deposit ?? lease.securityDeposit ?? '—')),
    docxParagraph('PARTIES AND AGREEMENT TERMS', 'Heading1'),
  ];
  for (const [index, clause] of clauses.entries()) {
    paragraphs.push(docxParagraph('CLAUSE ' + (index + 1) + '. ' + clause.title, 'Heading2'));
    paragraphs.push(docxParagraph(clause.body));
  }
  paragraphs.push(
    docxParagraph('IMPORTANT: This corrected document is an unsigned draft. It does not replace or amend an existing signed lease until both parties have reviewed and signed the corrected version.', 'Warning'),
    docxParagraph('SIGNATURES', 'Heading1'),
    docxParagraph('Tenant signature: ____________________________________       Date: __________________'),
    docxParagraph('Tenant name: ' + (tenant?.name || '—')),
    docxParagraph('For Riiroow Apartments Management: __________________________       Date: __________________')
  );

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Warning"><w:name w:val="Warning"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="A16207"/><w:sz w:val="22"/></w:rPr></w:style>' +
    '</w:styles>';
  return createDocxZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml,
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  });
};
