import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

export const SIGNATURE_PNG_MAX_BYTES = 2 * 1024 * 1024;

export const SIGNATURE_SOURCE_MAX_BYTES = 1536 * 1024;

export const decodeSignatureSourceImage = (dataUrl) => {
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('Upload a JPEG or PNG photograph of the signed paper.'), { statusCode: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  const isJpeg = match[1] === 'jpeg'
    && buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = match[1] === 'png'
    && buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!buffer.length || buffer.length > SIGNATURE_SOURCE_MAX_BYTES || buffer.toString('base64') !== match[2] || (!isJpeg && !isPng)) {
    throw Object.assign(new Error('The source photograph is invalid or exceeds 1.5 MB. Please upload a smaller JPEG or PNG.'), { statusCode: 400 });
  }
  return { buffer, mimeType: isJpeg ? 'image/jpeg' : 'image/png', extension: isJpeg ? 'jpg' : 'png' };
};


const pngCrc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const decodeSignaturePng = (dataUrl) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('Signature must be a PNG image.'), { statusCode: 400 });
  const buffer = Buffer.from(match[1], 'base64');
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    !buffer.length ||
    buffer.length > SIGNATURE_PNG_MAX_BYTES ||
    buffer.toString('base64') !== match[1] ||
    buffer.length < 45 ||
    !buffer.subarray(0, 8).equals(pngHeader) ||
    buffer.readUInt32BE(16) < 1 ||
    buffer.readUInt32BE(16) > 3000 ||
    buffer.readUInt32BE(20) < 1 ||
    buffer.readUInt32BE(20) > 1200
  ) {
    throw Object.assign(new Error('Signature image is invalid or exceeds 2 MB.'), { statusCode: 400 });
  }

  let offset = 8;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (length > buffer.length || crcOffset + 4 > buffer.length) break;
    const type = buffer.toString('ascii', typeStart, dataStart);
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = pngCrc32(buffer.subarray(typeStart, crcOffset));
    if (expectedCrc !== actualCrc) break;

    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) break;
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      if (width < 1 || width > 3000 || height < 1 || height > 1200 || bitDepth !== 8 || colorType !== 6) break;
      sawHeader = true;
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !sawImageData || crcOffset + 4 !== buffer.length) break;
      sawEnd = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== buffer.length) {
    throw Object.assign(new Error('Signature image is invalid or exceeds 2 MB.'), { statusCode: 400 });
  }
  return buffer;
};

export const hashLeaseSnapshot = (snapshot) =>
  crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

const formatSigningDate = (value) => new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Africa/Mogadishu',
}).format(new Date(value));

const addSectionHeading = (doc, title, y) => {
  doc.font('Helvetica-Bold').fontSize(12.75).fillColor('#222222')
    .text(title, 51, y, { width: 493, lineBreak: false });
  doc.moveTo(51, y + 19).lineTo(544, y + 19).strokeColor('#bbbbbb').lineWidth(0.7).stroke();
  return y + 27;
};

const drawDetail = (doc, label, value, x, y, width) => {
  doc.font('Helvetica-Bold').fontSize(9.75).fillColor('#222222')
    .text(label + ':', x, y + 6, { continued: true });
  doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
    .text(' ' + String(value || '—'), { width: width - 8 });
  doc.moveTo(x, y + 25).lineTo(x + width, y + 25).strokeColor('#eeeeee').lineWidth(0.55).stroke();
};

const drawDetailsGrid = (doc, fields, y) => {
  const columnGap = 26;
  const columnWidth = (493 - columnGap) / 2;
  fields.forEach((field, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    drawDetail(doc, field[0], field[1], 51 + column * (columnWidth + columnGap), y + row * 31, columnWidth);
  });
  return y + Math.ceil(fields.length / 2) * 31;
};

export const createSignedLeasePdf = ({ snapshot, tenantSignature, managerSignature, tenantSignedAt, managerSignedAt, tenantName, managerName, sessionId, qrBuffer, tenantPhoto }) =>
  new Promise((resolve, reject) => {
    // Keep the signed PDF on the same A4 page geometry and section order as
    // the manager's browser-print lease. Signature images occupy the existing
    // signature whitespace; they do not add layout height or move later text.
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 51, bottom: 51, left: 51, right: 51 },
      bufferPages: true,
      info: {
        Title: 'Riiroow Signed Lease Agreement',
        Author: 'Riiroow Apartments',
        Subject: 'Signed lease ' + snapshot.id,
        CreationDate: new Date(managerSignedAt),
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pageWidth = 493;
    let y = 51;

    // Header mirrors the unsigned print template's centered brand, title,
    // lease reference, divider, and vertical spacing.
    doc.font('Helvetica-Bold').fontSize(16.5).fillColor('#222222')
      .text('RIIROOW APARTMENT', 51, y + 58, { width: pageWidth, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(13.5).fillColor('#222222')
      .text('LEASE SUMMARY', 51, y + 82, { width: pageWidth, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#666666')
      .text('Lease ID: ' + String(snapshot.id || '—'), 51, y + 105, { width: pageWidth, align: 'center', lineBreak: false });
    doc.moveTo(51, y + 124).lineTo(544, y + 124).strokeColor('#222222').lineWidth(2.25).stroke();
    y += 145;

    if (tenantPhoto) {
      doc.image(tenantPhoto, 51, y, { fit: [78, 93] });
      y += 105;
    }

    y = addSectionHeading(doc, '1. Tenant Information', y);
    y = drawDetailsGrid(doc, [
      ['Tenant Name', snapshot.tenant_name || tenantName],
      ['Phone', snapshot.tenant_phone],
      ['Email', snapshot.tenant_email],
      ['Unit Number', snapshot.unit_number ?? snapshot.unit_id],
    ], y);

    y += 11;
    y = addSectionHeading(doc, '2. Lease Term', y);
    y = drawDetailsGrid(doc, [
      ['Start Date', snapshot.start_date],
      ['End Date', snapshot.end_date],
      ['Lease Status', snapshot.status],
      ['Unit', snapshot.unit_number ?? snapshot.unit_id],
    ], y);

    y += 11;
    y = addSectionHeading(doc, '3. Rent and Security Deposit', y);
    y = drawDetailsGrid(doc, [
      ['Monthly Rent', '$' + Number(snapshot.monthly_rent || 0).toFixed(2)],
      ['Security Deposit', '$' + Number(snapshot.security_deposit || 0).toFixed(2)],
    ], y);

    y += 11;
    y = addSectionHeading(doc, '4. Additional Notes', y);
    doc.rect(51, y, pageWidth, 53).lineWidth(0.7).strokeColor('#cccccc').stroke();
    doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
      .text(String(snapshot.notes || 'No additional notes.'), 60, y + 8, {
        width: pageWidth - 18,
        height: 37,
        lineBreak: true,
      });
    y += 70;

    // The unsigned template has a fixed two-column signature block. Keep its
    // top border, labels, names, and date baselines fixed in both versions.
    const signatureTop = y + 41;
    const signatureGap = 30;
    const signatureWidth = (pageWidth - signatureGap) / 2;
    const leftX = 51;
    const rightX = leftX + signatureWidth + signatureGap;
    const blockHeight = 100;
    if (signatureTop + blockHeight + 80 > 790) {
      doc.addPage();
      y = 51;
    } else {
      y = signatureTop;
    }

    const blockY = y;
    [leftX, rightX].forEach((x) => {
      doc.moveTo(x, blockY).lineTo(x + signatureWidth, blockY).strokeColor('#222222').lineWidth(0.7).stroke();
    });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222')
      .text('Tenant Signature', leftX, blockY + 8, { width: signatureWidth, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222')
      .text('Riiroow Apartment Management', rightX, blockY + 8, { width: signatureWidth, lineBreak: false });

    // Signature artwork is drawn into the blank area already reserved by the
    // printed form. It does not participate in text flow.
    doc.image(tenantSignature, leftX, blockY + 25, { fit: [signatureWidth - 8, 39], align: 'left', valign: 'center' });
    doc.image(managerSignature, rightX, blockY + 25, { fit: [signatureWidth - 8, 39], align: 'left', valign: 'center' });

    doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
      .text('Name: ' + String(tenantName || snapshot.tenant_name || '—'), leftX, blockY + 70, { width: signatureWidth });
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555')
      .text('Date: ' + formatSigningDate(tenantSignedAt) + ' EAT', leftX, blockY + 85, { width: signatureWidth });
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555')
      .text('Date: ' + formatSigningDate(managerSignedAt) + ' EAT', rightX, blockY + 85, { width: signatureWidth });

    y = blockY + blockHeight + 45;
    doc.moveTo(51, y).lineTo(544, y).strokeColor('#cccccc').lineWidth(0.7).stroke();
    doc.font('Helvetica').fontSize(8.25).fillColor('#666666')
      .text('Riiroow Apartment Management — Residential Lease Agreement', 51, y + 10, {
        width: pageWidth,
        align: 'center',
        lineBreak: false,
      });

    y += 45;
    if (y > 650) {
      doc.addPage();
      y = 51;
    }
    doc.moveTo(51, y).lineTo(544, y).strokeColor('#cccccc').lineWidth(0.7).stroke();
    doc.font('Helvetica-Bold').fontSize(12.75).fillColor('#222222')
      .text('Lease Document Archive', 51, y + 12, { width: pageWidth, align: 'center' });
    doc.font('Helvetica').fontSize(8.25).fillColor('#555555')
      .text('Scan this code to view scanned documents attached to this specific lease.', 65, y + 33, {
        width: pageWidth - 28,
        align: 'center',
      });
    if (qrBuffer) {
      doc.image(qrBuffer, 51, y + 54, { fit: [120, 120], align: 'center' });
    }

    const pageRange = doc.bufferedPageRange();
    for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      doc.font('Helvetica').fontSize(8).fillColor('#777777')
        .text('Page ' + (pageIndex + 1) + ' of ' + pageRange.count, 51, 775, {
          width: 493,
          align: 'right',
          lineBreak: false,
        });
    }
    doc.end();
  });
