import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSignaturePng, hashLeaseSnapshot } from '../src/leaseSigning.js';

const minimalPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
]);

test('decodeSignaturePng accepts a PNG data URL', () => {
  const input = `data:image/png;base64,${minimalPng.toString('base64')}`;
  assert.deepEqual(decodeSignaturePng(input), minimalPng);
});

test('decodeSignaturePng rejects non-PNG and malformed data URLs', () => {
  assert.throws(() => decodeSignaturePng('data:image/jpeg;base64,AAAA'), /PNG/);
  assert.throws(() => decodeSignaturePng('not-an-image'), /PNG/);
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
