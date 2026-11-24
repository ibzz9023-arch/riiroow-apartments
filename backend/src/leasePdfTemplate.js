import PDFDocument from 'pdfkit';

const PAGE = { width: 595.28, height: 841.89, left: 51, right: 51 };
const CONTENT_WIDTH = PAGE.width - PAGE.left - PAGE.right;
const COLORS = { ink: '#222222', muted: '#666666', line: '#cccccc', pale: '#eeeeee' };

const text = (doc, value, x, y, width, options = {}) => {
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(options.size || 10)
    .fillColor(options.color || COLORS.ink)
    .text(String(value ?? '—'), x, y, { width, lineGap: 1.5, ...options });
  return doc.y;
};

const sectionHeading = (doc, title, y) => {
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.ink)
    .text(title, PAGE.left, y, { width: CONTENT_WIDTH });
  const lineY = doc.y + 5;
  doc.moveTo(PAGE.left, lineY).lineTo(PAGE.width - PAGE.right, lineY)
    .lineWidth(0.6).strokeColor('#bbbbbb').stroke();
  return lineY + 13;
};

const drawGrid = (doc, fields, y) => {
  const gap = 28;
  const columnWidth = (CONTENT_WIDTH - gap) / 2;
  let rowY = y;
  for (let index = 0; index < fields.length; index += 2) {
    const row = fields.slice(index, index + 2);
    const heights = row.map((field, column) => {
      const x = PAGE.left + column * (columnWidth + gap);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555')
        .text(field.label.toUpperCase(), x, rowY, { width: columnWidth });
      const valueY = doc.y + 3;
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink)
        .text(String(field.value ?? '—'), x, valueY, { width: columnWidth, lineGap: 1.5 });
      const bottom = doc.y + 7;
      doc.moveTo(x, bottom).lineTo(x + columnWidth, bottom)
        .lineWidth(0.45).strokeColor(COLORS.pale).stroke();
      return bottom + 7;
    });
    rowY = Math.max(...heights);
  }
  return rowY + 5;
};

const drawSignatureBoxes = (doc, {
  tenantSignature, managerSignature, tenantSignedAt, managerSignedAt,
  tenantName, managerName,
}) => {
  const gap = 28;
  const columnWidth = (CONTENT_WIDTH - gap) / 2;
  const top = doc.y;
  const boxHeight = 124;
  const drawOne = (x, title, signature, name, signedAt) => {
    doc.moveTo(x, top).lineTo(x + columnWidth, top)
      .lineWidth(0.8).strokeColor(COLORS.ink).stroke();
    text(doc, title, x, top + 8, columnWidth, { bold: true, size: 9 });
    // The signature image always occupies this reserved rectangle. Unsigned
    // leases leave it empty, so all content below stays at the same coordinates.
    if (signature) {
      doc.image(signature, x + 2, top + 25, {
        fit: [columnWidth - 8, 48],
        align: 'left',
        valign: 'center',
      });
    }
    text(doc, name || 'Name: ____________________', x, top + 78, columnWidth, { size: 9 });
    text(doc, signedAt ? `Date: ${signedAt}` : 'Date: ____________________', x, top + 96, columnWidth, { size: 8, color: COLORS.muted });
  };
  drawOne(PAGE.left, 'TENANT SIGNATURE', tenantSignature, tenantName ? `Name: ${tenantName}` : 'Name: ____________________', tenantSignedAt);
  drawOne(PAGE.left + columnWidth + gap, 'RIIROOW APARTMENT MANAGEMENT', managerSignature, managerName ? `Name: ${managerName}` : 'Name: ____________________', managerSignedAt);
  doc.y = top + boxHeight;
};

export const createLeasePdf = ({
  snapshot,
  tenantPhoto = null,
  tenantSignature = null,
  managerSignature = null,
  tenantSignedAt = null,
  managerSignedAt = null,
  tenantName = snapshot.tenant_name,
  managerName = null,
  qrBuffer = null,
  logoBuffer = null,
}) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 42, bottom: 48, left: PAGE.left, right: PAGE.right },
    bufferPages: true,
    info: {
      Title: tenantSignedAt && managerSignedAt ? 'Riiroow Signed Lease Agreement' : 'Riiroow Lease Agreement',
      Author: 'Riiroow Apartments',
      Subject: `Lease ${snapshot.id}`,
      ...(managerSignedAt ? { CreationDate: new Date(managerSignedAt) } : {}),
    },
  });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('error', reject);
  doc.on('end', () => resolve(Buffer.concat(chunks)));

  if (logoBuffer) {
    try { doc.image(logoBuffer, PAGE.width / 2 - 62, 34, { fit: [124, 52], align: 'center', valign: 'center' }); } catch { /* optional brand asset */ }
  }
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.ink)
    .text('RIIROOW APARTMENT', PAGE.left, logoBuffer ? 91 : 43, { width: CONTENT_WIDTH, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.ink)
    .text('LEASE SUMMARY', PAGE.left, doc.y + 4, { width: CONTENT_WIDTH, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
    .text(`Lease ID: ${snapshot.id}`, PAGE.left, doc.y + 5, { width: CONTENT_WIDTH, align: 'center' });
  doc.moveTo(PAGE.left, doc.y + 9).lineTo(PAGE.width - PAGE.right, doc.y + 9)
    .lineWidth(2).strokeColor(COLORS.ink).stroke();
  let y = doc.y + 25;

  y = sectionHeading(doc, '1. Tenant Information', y);
  if (tenantPhoto) {
    try {
      doc.image(tenantPhoto, PAGE.left, y, { fit: [78, 92] });
      y += 101;
    } catch { /* optional tenant photo */ }
  }
  y = drawGrid(doc, [
    { label: 'Tenant Name', value: snapshot.tenant_name },
    { label: 'Phone', value: snapshot.tenant_phone },
    { label: 'Email', value: snapshot.tenant_email },
    { label: 'Unit Number', value: snapshot.unit_number ?? snapshot.unit_id },
  ], y);

  y = sectionHeading(doc, '2. Lease Term', y + 7);
  y = drawGrid(doc, [
    { label: 'Start Date', value: snapshot.start_date },
    { label: 'End Date', value: snapshot.end_date },
    { label: 'Lease Status', value: snapshot.status },
    { label: 'Unit', value: snapshot.unit_number ?? snapshot.unit_id },
  ], y);

  y = sectionHeading(doc, '3. Rent and Security Deposit', y + 7);
  y = drawGrid(doc, [
    { label: 'Monthly Rent', value: `$${Number(snapshot.monthly_rent || 0).toFixed(2)}` },
    { label: 'Security Deposit', value: `$${Number(snapshot.security_deposit || 0).toFixed(2)}` },
  ], y);

  y = sectionHeading(doc, '4. Additional Notes', y + 7);
  const notesTop = y;
  doc.rect(PAGE.left, notesTop, CONTENT_WIDTH, 58).lineWidth(0.7).strokeColor('#cccccc').stroke();
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.ink)
    .text(snapshot.notes || 'No additional notes.', PAGE.left + 10, notesTop + 9, {
      width: CONTENT_WIDTH - 20,
      height: 40,
      lineGap: 1.5,
      ellipsis: true,
    });
  y = notesTop + 76;

  // Keep the complete signature section together. This check depends only on
  // the lease text, never on whether signature images are present.
  if (y + 140 > PAGE.height - 175) {
    doc.addPage();
    y = 48;
  }
  y = sectionHeading(doc, '5. Signatures', y);
  doc.y = y + 4;
  drawSignatureBoxes(doc, {
    tenantSignature,
    managerSignature,
    tenantSignedAt,
    managerSignedAt,
    tenantName,
    managerName,
  });

  const footerY = Math.min(doc.y + 20, PAGE.height - 145);
  doc.moveTo(PAGE.left, footerY).lineTo(PAGE.width - PAGE.right, footerY)
    .lineWidth(0.6).strokeColor(COLORS.line).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
    .text('Riiroow Apartment Management — Residential Lease Agreement', PAGE.left, footerY + 10, {
      width: CONTENT_WIDTH,
      align: 'center',
    });

  const qrTop = footerY + 31;
  if (qrBuffer && qrTop + 132 < PAGE.height - 48) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.ink)
      .text('LEASE DOCUMENT ARCHIVE', PAGE.left, qrTop, { width: CONTENT_WIDTH, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text('Scan this code to view scanned documents attached to this specific lease.', PAGE.left, qrTop + 13, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    doc.image(qrBuffer, PAGE.width / 2 - 48, qrTop + 30, { width: 96, height: 96 });
  }

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(`Page ${index + 1} of ${pages.count}`, PAGE.left, 786, {
        width: CONTENT_WIDTH,
        align: 'right',
        lineBreak: false,
      });
  }
  doc.end();
});
