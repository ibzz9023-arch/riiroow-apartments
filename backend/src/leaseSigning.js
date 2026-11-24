import crypto from 'node:crypto';
import { createLeasePdf } from './leasePdfTemplate.js';

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

const addField = (doc, label, value) => {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text(label.toUpperCase());
  doc.font('Helvetica').fontSize(11).fillColor('#171717').text(String(value || '—'), { width: 500 });
  doc.moveDown(0.7);
};

export const createSignedLeasePdf = (options) => createLeasePdf(options);
