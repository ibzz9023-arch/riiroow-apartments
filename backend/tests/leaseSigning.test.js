import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createSignedLeasePdf, decodeSignaturePng, decodeSignatureSourceImage, hashLeaseSnapshot } from '../src/leaseSigning.js';
import { createLeasePdf } from '../src/leasePdfTemplate.js';


const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
};

const validPng = () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const imageData = deflateSync(Buffer.from([0, 20, 20, 20, 255]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', imageData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const minimalPng = validPng();

test('decodeSignaturePng accepts a PNG data URL', () => {
  const input = `data:image/png;base64,${minimalPng.toString('base64')}`;
  assert.deepEqual(decodeSignaturePng(input), minimalPng);
});

test('decodeSignaturePng rejects non-PNG and malformed data URLs', () => {
  assert.throws(() => decodeSignaturePng('data:image/jpeg;base64,AAAA'), /PNG/);
  assert.throws(() => decodeSignaturePng('not-an-image'), /PNG/);
});

test('decodeSignaturePng rejects corrupted PNG chunk checksums', () => {
  const corrupted = Buffer.from(minimalPng);
  corrupted[corrupted.length - 1] ^= 0xff;
  const input = `data:image/png;base64,${corrupted.toString('base64')}`;
  assert.throws(() => decodeSignaturePng(input), /invalid or exceeds 2 MB/);
});

test('decodeSignaturePng rejects trailing data after the PNG end marker', () => {
  const input = `data:image/png;base64,${Buffer.concat([minimalPng, Buffer.from([0])]).toString('base64')}`;
  assert.throws(() => decodeSignaturePng(input), /invalid or exceeds 2 MB/);
});

test('decodeSignaturePng enforces the signature size limit', () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  const input = `data:image/png;base64,${oversized.toString('base64')}`;
  assert.throws(() => decodeSignaturePng(input), /invalid or exceeds 2 MB/);
});

test('lease snapshot hashes are deterministic and change with lease terms', () => {
  const first = { id: 'lease-1', rent: 500, tenant: 'Tenant' };
  const same = { id: 'lease-1', rent: 500, tenant: 'Tenant' };
  const changed = { id: 'lease-1', rent: 600, tenant: 'Tenant' };
  assert.equal(hashLeaseSnapshot(first), hashLeaseSnapshot(same));
  assert.notEqual(hashLeaseSnapshot(first), hashLeaseSnapshot(changed));
});

test('decodeSignaturePng rejects excessive image dimensions', () => {
  const huge = Buffer.from(minimalPng);
  huge.writeUInt32BE(5000, 16);
  const input = `data:image/png;base64,${huge.toString('base64')}`;
  assert.throws(() => decodeSignaturePng(input), /invalid or exceeds 2 MB/);
});

test('createSignedLeasePdf generates a readable PDF with both signatures and archive QR', async () => {
  const signature = validPng();
  const pdf = await createSignedLeasePdf({
    snapshot: {
      id: 'lease-test-001',
      unit_number: 101,
      tenant_name: 'Test Tenant',
      tenant_phone: '+252 600000000',
      tenant_email: 'tenant@example.test',
      start_date: '2026-12-01',
      end_date: '2027-11-30',
      monthly_rent: 500,
      security_deposit: 500,
      status: 'Active',
      notes: 'Test lease terms',
    },
    tenantSignature: signature,
    managerSignature: signature,
    tenantSignedAt: '2026-11-24T08:00:00.000Z',
    managerSignedAt: '2026-11-25T09:30:00.000Z',
    tenantName: 'Test Tenant',
    managerName: 'Test Manager',
    sessionId: 'session-test-001',
    qrBuffer: signature,
  });
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(pdf.length > 1000);
});


test('unsigned and signed lease PDFs use the same page layout and pagination', async () => {
  const signature = validPng();
  const snapshot = {
    id: 'lease-layout-test',
    unit_number: 101,
    tenant_name: 'Layout Test Tenant',
    tenant_phone: '+252 600000000',
    tenant_email: 'tenant@example.test',
    start_date: '2026-12-01',
    end_date: '2027-11-30',
    monthly_rent: 500,
    security_deposit: 500,
    status: 'Active',
    notes: 'The same lease notes must occupy the same area before and after signing.',
  };
  const common = { snapshot, qrBuffer: signature };
  const unsignedPdf = await createLeasePdf(common);
  const signedPdf = await createLeasePdf({
    ...common,
    tenantSignature: signature,
    managerSignature: signature,
    tenantSignedAt: '2026-11-24T08:00:00.000Z',
    managerSignedAt: '2026-11-25T09:30:00.000Z',
    tenantName: 'Layout Test Tenant',
    managerName: 'Layout Test Manager',
  });
  const countPages = (pdf) => (pdf.toString('latin1').match(/\\/Type\\s*\\/Page\\b/g) || []).length;
  assert.equal(countPages(signedPdf), countPages(unsignedPdf));
  assert.ok(unsignedPdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(signedPdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
});

test('decodeSignatureSourceImage accepts a JPEG source photograph', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const result = decodeSignatureSourceImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.extension, 'jpg');
  assert.deepEqual(result.buffer, jpeg);
});

test('decodeSignatureSourceImage accepts a PNG source photograph', () => {
  const png = validPng();
  const result = decodeSignatureSourceImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.extension, 'png');
  assert.deepEqual(result.buffer, png);
});

test('decodeSignatureSourceImage rejects mismatched or oversized source images', () => {
  assert.throws(() => decodeSignatureSourceImage('data:image/jpeg;base64,AAAA'), /invalid or exceeds 1.5 MB/);
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1536 * 1024)]);
  assert.throws(() => decodeSignatureSourceImage(`data:image/jpeg;base64,${oversized.toString('base64')}`), /invalid or exceeds 1.5 MB/);
});
