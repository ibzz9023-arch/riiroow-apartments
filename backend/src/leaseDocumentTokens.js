import crypto from 'node:crypto';

export const LEASE_DOCUMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashLeaseDocumentToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

export const createLeaseDocumentNonce = () =>
  crypto.randomBytes(32).toString('base64url');

/**
 * Derive a stable, unguessable bearer token for a lease from a random database
 * nonce and the server-only session secret. Only the SHA-256 hash and nonce
 * are persisted; the token can be re-derived for printing until rotated.
 */
export const deriveLeaseDocumentToken = (leaseId, nonce, secret) =>
  crypto
    .createHmac('sha256', secret)
    .update(`riiroow:lease-documents:v1:${String(leaseId)}:${String(nonce)}`)
    .digest('base64url');

export const leaseDocumentTokenMatchesHash = (token, expectedHash) => {
  const actual = Buffer.from(hashLeaseDocumentToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length &&
    actual.length === 32 &&
    crypto.timingSafeEqual(actual, expected);
};
