import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

export const SIGNATURE_PNG_MAX_BYTES = 2 * 1024 * 1024;

export const decodeSignaturePng = (dataUrl) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('Signature must be a PNG image.'), { statusCode: 400 });
  const buffer = Buffer.from(match[1], 'base64');
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    !buffer.length ||
    buffer.length > SIGNATURE_PNG_MAX_BYTES ||
    buffer.toString('base64') !== match[1] ||
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(pngHeader)
  ) {
    throw Object.assign(new Error('Signature image is invalid or exceeds 2 MB.'), { statusCode: 400 });
  }
  return buffer;
};

export const hashLeaseSnapshot = (snapshot) =>
  crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

const formatSigningDate = (value) => new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
}).format(new Date(value));

const addField = (doc, label, value) => {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text(label.toUpperCase());
  doc.font('Helvetica').fontSize(11).fillColor('#171717').text(String(value || '—'), { width: 500 });
  doc.moveDown(0.7);
};

export const createSignedLeasePdf = ({ snapshot, tenantSignature, managerSignature, tenantSignedAt, managerSignedAt, tenantName, managerName, sessionId }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 52, bottom: 52, left: 54, right: 54 }, info: {
      Title: 'Riiroow Signed Lease Agreement',
      Author: 'Riiroow Apartments',
      Subject: `Signed lease ${snapshot.id}`,
    } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#171717').text('RIIROOW APARTMENTS');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).fillColor('#777777').text('RESIDENTIAL LEASE AGREEMENT');
    doc.moveDown(1.4);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#171717').text('Lease details');
    doc.moveDown(0.8);
    addField(doc, 'Lease reference', snapshot.id);
    addField(doc, 'Unit', snapshot.unit_number ?? snapshot.unit_id ?? '—');
    addField(doc, 'Tenant', snapshot.tenant_name);
    addField(doc, 'Tenant phone', snapshot.tenant_phone);
    addField(doc, 'Tenant email', snapshot.tenant_email);
    addField(doc, 'Lease period', `${snapshot.start_date || '—'} to ${snapshot.end_date || '—'}`);
    addField(doc, 'Monthly rent', `$${Number(snapshot.monthly_rent || 0).toFixed(2)}`);
    addField(doc, 'Security deposit', `$${Number(snapshot.security_deposit || 0).toFixed(2)}`);
    addField(doc, 'Lease status at signing', snapshot.status);
    if (snapshot.notes) addField(doc, 'Additional terms / notes', snapshot.notes);

    if (doc.y > 450) doc.addPage();
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#171717').text('Signatures');
    doc.moveDown(0.8);
    const signatureWidth = 205;
    const leftX = 54;
    const rightX = 330;
    const signatureY = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333').text('TENANT', leftX, signatureY);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333').text('MANAGER', rightX, signatureY);
    doc.image(tenantSignature, leftX, signatureY + 20, { fit: [signatureWidth, 82], align: 'center', valign: 'center' });
    doc.image(managerSignature, rightX, signatureY + 20, { fit: [signatureWidth, 82], align: 'center', valign: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#171717').text(tenantName, leftX, signatureY + 112, { width: signatureWidth });
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text(`Signed: ${formatSigningDate(tenantSignedAt)} UTC`, leftX, signatureY + 128, { width: signatureWidth });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#171717').text(managerName, rightX, signatureY + 112, { width: signatureWidth });
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text(`Signed: ${formatSigningDate(managerSignedAt)} UTC`, rightX, signatureY + 128, { width: signatureWidth });

    doc.moveTo(leftX, signatureY + 158).lineTo(leftX + signatureWidth, signatureY + 158).strokeColor('#999999').stroke();
    doc.moveTo(rightX, signatureY + 158).lineTo(rightX + signatureWidth, signatureY + 158).strokeColor('#999999').stroke();
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#777777')
      .text(`Signing record: ${sessionId}`, { align: 'left' });
    doc.text('Each signing date above is recorded independently by the Riiroow server (UTC).');
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#171717').text('LEASE DOCUMENT ARCHIVE');
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text('Scan this QR code to view this signed lease and other documents attached to this lease.');
    doc.moveDown(0.5);
    doc.image(qrBuffer, { width: 112, height: 112, align: 'center' });
    doc.end();
  });
