import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEASE_DOCUMENT_TOKEN_PATTERN,
  createLeaseDocumentNonce,
  deriveLeaseDocumentToken,
  hashLeaseDocumentToken,
  leaseDocumentTokenMatchesHash,
} from '../src/leaseDocumentTokens.js';

test('lease document token is stable for the same lease, nonce, and secret', () => {
  const nonce = createLeaseDocumentNonce();
  const secret = Buffer.alloc(32, 7);
  const first = deriveLeaseDocumentToken('lease-123', nonce, secret);
  const second = deriveLeaseDocumentToken('lease-123', nonce, secret);

  assert.equal(first, second);
  assert.match(first, LEASE_DOCUMENT_TOKEN_PATTERN);
  assert.equal(leaseDocumentTokenMatchesHash(first, hashLeaseDocumentToken(first)), true);
});

test('lease document token changes for a different lease, nonce, or secret', () => {
  const nonce = createLeaseDocumentNonce();
  const otherNonce = createLeaseDocumentNonce();
  const secret = Buffer.alloc(32, 7);

  const token = deriveLeaseDocumentToken('lease-123', nonce, secret);
  assert.notEqual(token, deriveLeaseDocumentToken('lease-456', nonce, secret));
  assert.notEqual(token, deriveLeaseDocumentToken('lease-123', otherNonce, secret));
  assert.notEqual(token, deriveLeaseDocumentToken('lease-123', nonce, Buffer.alloc(32, 8)));
});

test('lease document token hash validation is constant-time and rejects mismatches', () => {
  const token = deriveLeaseDocumentToken('lease-123', createLeaseDocumentNonce(), Buffer.alloc(32, 9));
  assert.equal(leaseDocumentTokenMatchesHash(token, hashLeaseDocumentToken(token)), true);
  assert.equal(leaseDocumentTokenMatchesHash(`${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`, hashLeaseDocumentToken(token)), false);
  assert.equal(leaseDocumentTokenMatchesHash(token, 'not-a-sha256-hash'), false);
});
