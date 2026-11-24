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


const PAGE = { width: 595.28, height: 841.89, margin: 51.02 };
const LAYOUT = {
  contentWidth: PAGE.width - PAGE.margin * 2,
  logoWidth: 135,
  logoHeight: 58.5,
  photoWidth: 78,
  photoHeight: 93,
  columnGap: 26.25,
  detailRowHeight: 27.375,
  signatureGap: 22.5,
  signatureHeight: 75,
};

const addPageIfNeeded = (doc, y, requiredHeight, bottom = 51) => {
  if (y + requiredHeight <= PAGE.height - bottom) return y;
  doc.addPage();
  return PAGE.margin;
};

const addSectionHeading = (doc, title, y) => {
  // Values are the original print CSS converted from CSS px to PDF points.
  y += 18.75; // h2 margin-top: 25px
  doc.font('Helvetica').fontSize(12.75).fillColor('#222222')
    .text(title, PAGE.margin, y, {
      width: LAYOUT.contentWidth,
      lineBreak: false,
      height: 19.125,
    });
  const ruleY = y + 23.625; // line box + 6px padding + border
  doc.moveTo(PAGE.margin, ruleY)
    .lineTo(PAGE.width - PAGE.margin, ruleY)
    .strokeColor('#bbbbbb').lineWidth(0.75).stroke();
  return ruleY + 9.75; // padding/border + h2 margin-bottom: 12px
};

const drawDetail = (doc, label, value, x, y, width) => {
  doc.font('Helvetica-Bold').fontSize(9.75).fillColor('#222222')
    .text(label + ':', x, y + 6, { continued: true, lineBreak: false });
  doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
    .text(' ' + String(value ?? '—'), {
      width: width - 8,
      height: 14.625,
      lineBreak: false,
    });
  doc.moveTo(x, y + LAYOUT.detailRowHeight - 0.75)
    .lineTo(x + width, y + LAYOUT.detailRowHeight - 0.75)
    .strokeColor('#eeeeee').lineWidth(0.75).stroke();
};

const drawDetailsGrid = (doc, fields, y) => {
  const columnWidth = (LAYOUT.contentWidth - LAYOUT.columnGap) / 2;
  fields.forEach((field, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    drawDetail(
      doc,
      field[0],
      field[1],
      PAGE.margin + column * (columnWidth + LAYOUT.columnGap),
      y + row * LAYOUT.detailRowHeight,
      columnWidth,
    );
  });
  return y + Math.ceil(fields.length / 2) * LAYOUT.detailRowHeight;
};

const drawSignatureBlock = (doc, {
  y,
  tenantSignature,
  managerSignature,
  tenantName,
  tenantSignedAt,
  managerSignedAt,
}) => {
  const gap = LAYOUT.signatureGap;
  const columnWidth = (LAYOUT.contentWidth - gap) / 2;
  const leftX = PAGE.margin;
  const rightX = leftX + columnWidth + gap;
  const top = y + 41.25; // signatures margin-top: 55px
  const blockBottom = top + LAYOUT.signatureHeight;

  [leftX, rightX].forEach((x) => {
    doc.moveTo(x, top).lineTo(x + columnWidth, top)
      .strokeColor('#222222').lineWidth(0.75).stroke();
  });

  doc.font('Helvetica-Bold').fontSize(9.75).fillColor('#222222')
    .text('Tenant Signature', leftX, top + 6, { width: columnWidth, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9.75).fillColor('#222222')
    .text('Riiroow Apartment Management', rightX, top + 6, { width: columnWidth, lineBreak: false });

  // Signatures are overlaid inside the blank line area of the original form.
  // They never change the baseline of the printed name or date fields.
  doc.image(tenantSignature, leftX, top + 17, {
    fit: [Math.min(195, columnWidth - 8), 24],
    align: 'left',
    valign: 'center',
  });
  doc.image(managerSignature, rightX, top + 17, {
    fit: [Math.min(195, columnWidth - 8), 24],
    align: 'left',
    valign: 'center',
  });

  doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
    .text('Name: ' + String(tenantName || '—'), leftX, top + 44, {
      width: columnWidth,
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(8.25).fillColor('#222222')
    .text('Date: ' + formatSigningDate(tenantSignedAt) + ' EAT', leftX, top + 62, {
      width: columnWidth,
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(8.25).fillColor('#222222')
    .text('Date: ' + formatSigningDate(managerSignedAt) + ' EAT', rightX, top + 62, {
      width: columnWidth,
      lineBreak: false,
    });
  return blockBottom;
};

export const createSignedLeasePdf = ({
  snapshot,
  tenantSignature,
  managerSignature,
  tenantSignedAt,
  managerSignedAt,
  tenantName,
  managerName,
  sessionId,
  qrBuffer,
  tenantPhoto,
}) => new Promise(async (resolve, reject) => {
  try {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE.margin,
        bottom: PAGE.margin,
        left: PAGE.margin,
        right: PAGE.margin,
      },
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

    let y = PAGE.margin;

    // Match the unsigned HTML/CSS header: fixed 180x78px logo frame,
    // centered brand, subtitle, lease ID, 3px divider and 20px bottom gap.
    const logoPath = new URL('../../frontend/public/riiroow-logo.png', import.meta.url);
    const { readFile } = await import('node:fs/promises');
    const logo = await readFile(logoPath);
    doc.image(logo, (PAGE.width - LAYOUT.logoWidth) / 2, y, {
      fit: [LAYOUT.logoWidth, LAYOUT.logoHeight],
      align: 'center',
      valign: 'center',
    });
    y += LAYOUT.logoHeight + 4.5;
    doc.font('Helvetica-Bold').fontSize(16.5).fillColor('#222222')
      .text('RIIROOW APARTMENT', PAGE.margin, y, {
        width: LAYOUT.contentWidth,
        align: 'center',
        lineBreak: false,
      });
    y += 28.5;
    doc.font('Helvetica-Bold').fontSize(13.5).fillColor('#222222')
      .text('LEASE SUMMARY', PAGE.margin, y, {
        width: LAYOUT.contentWidth,
        align: 'center',
        lineBreak: false,
      });
    y += 23.25;
    doc.font('Helvetica').fontSize(9).fillColor('#666666')
      .text('Lease ID: ' + String(snapshot.id || '—'), PAGE.margin, y, {
        width: LAYOUT.contentWidth,
        align: 'center',
        lineBreak: false,
      });
    y += 23.25;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y)
      .strokeColor('#222222').lineWidth(2.25).stroke();
    y += 17.25; // header margin-bottom: 20px

    // The original template places the tenant-information heading before
    // the photo. The photo uses the same 104x124px CSS dimensions.
    y = addSectionHeading(doc, '1. Tenant Information', y);
    if (tenantPhoto) {
      y = addPageIfNeeded(doc, y, LAYOUT.photoHeight + 10.5);
      doc.image(tenantPhoto, PAGE.margin, y, {
        fit: [LAYOUT.photoWidth, LAYOUT.photoHeight],
        align: 'left',
        valign: 'center',
      });
      y += LAYOUT.photoHeight + 10.5; // photo wrapper bottom margin: 14px
    }
    y = drawDetailsGrid(doc, [
      ['Tenant Name', snapshot.tenant_name || tenantName],
      ['Phone', snapshot.tenant_phone],
      ['Email', snapshot.tenant_email],
      ['Unit Number', snapshot.unit_number ?? snapshot.unit_id],
    ], y);

    y = addSectionHeading(doc, '2. Lease Term', y);
    y = drawDetailsGrid(doc, [
      ['Start Date', snapshot.start_date],
      ['End Date', snapshot.end_date],
      ['Lease Status', snapshot.status],
      ['Unit', snapshot.unit_number ?? snapshot.unit_id],
    ], y);

    y = addSectionHeading(doc, '3. Rent and Security Deposit', y);
    y = drawDetailsGrid(doc, [
      ['Monthly Rent', '$' + Number(snapshot.monthly_rent || 0).toFixed(2)],
      ['Security Deposit', '$' + Number(snapshot.security_deposit || 0).toFixed(2)],
    ], y);

    y = addSectionHeading(doc, '4. Additional Notes', y);
    const notesHeight = 72.5; // 70px min-height + 2px border + 24px padding
    y = addPageIfNeeded(doc, y, notesHeight + 41.25 + LAYOUT.signatureHeight + 50);
    doc.rect(PAGE.margin, y, LAYOUT.contentWidth, notesHeight)
      .lineWidth(0.75).strokeColor('#cccccc').stroke();
    doc.font('Helvetica').fontSize(9.75).fillColor('#222222')
      .text(String(snapshot.notes || 'No additional notes.'), PAGE.margin + 9,
        y + 9, {
          width: LAYOUT.contentWidth - 18,
          height: notesHeight - 18,
          lineBreak: true,
        });
    y += notesHeight;

    y = drawSignatureBlock(doc, {
      y,
      tenantSignature,
      managerSignature,
      tenantName: tenantName || snapshot.tenant_name,
      tenantSignedAt,
      managerSignedAt,
    });

    // Match the unsigned footer and QR archive margins/sizing. Keep the
    // archive together on one page as required by the original CSS.
    y += 33.75;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y)
      .strokeColor('#cccccc').lineWidth(0.75).stroke();
    y += 9;
    doc.font('Helvetica').fontSize(8.25).fillColor('#666666')
      .text('Riiroow Apartment Management — Residential Lease Agreement',
        PAGE.margin, y, {
          width: LAYOUT.contentWidth,
          align: 'center',
          lineBreak: false,
        });
    y += 32.5; // footer line box + QR section margin-top
    const archiveHeight = 13.5 + 18.75 + 23.625 + 9 + 8 + 127.5 + 12;
    y = addPageIfNeeded(doc, y, archiveHeight);
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y)
      .strokeColor('#cccccc').lineWidth(0.75).stroke();
    y += 13.5;
    doc.font('Helvetica-Bold').fontSize(12.75).fillColor('#222222')
      .text('Lease Document Archive', PAGE.margin, y, {
        width: LAYOUT.contentWidth,
        align: 'center',
        lineBreak: false,
      });
    y += 28;
    doc.font('Helvetica').fontSize(8.25).fillColor('#555555')
      .text('Scan this code to view scanned documents attached to this specific lease.',
        PAGE.margin + 10, y, {
          width: LAYOUT.contentWidth - 20,
          align: 'center',
        });
    y += 23;
    doc.font('Helvetica').fontSize(8.25).fillColor('#555555')
      .text('Anyone with this QR code or link can access these documents until management revokes or regenerates the link.',
        PAGE.margin + 10, y, {
          width: LAYOUT.contentWidth - 20,
          align: 'center',
        });
    y += 24;
    if (qrBuffer) {
      doc.image(qrBuffer, (PAGE.width - 127.5) / 2, y, {
        fit: [127.5, 127.5],
        align: 'center',
        valign: 'center',
      });
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.font('Helvetica').fontSize(8).fillColor('#777777')
        .text('Page ' + (index + 1) + ' of ' + range.count,
          PAGE.margin, 775, {
            width: LAYOUT.contentWidth,
            align: 'right',
            lineBreak: false,
          });
    }
    doc.end();
  } catch (error) {
    reject(error);
  }
});
