import crypto from 'node:crypto';
import { getAuthenticatedUserById } from './dataService.js';

export const SESSION_ISSUER = 'riiroow-apartments-api';
export const SESSION_AUDIENCE = 'riiroow-apartments-web';
export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Map([
  ['admin', 'Admin'],
  ['manager', 'Manager'],
  ['accountant', 'Accountant'],
  ['maintenance', 'Maintenance'],
]);

export class SessionConfigurationError extends Error {
  constructor() {
    super('SESSION_SECRET must be canonical base64url encoding of at least 32 random bytes.');
    this.name = 'SessionConfigurationError';
  }
}

class InvalidSessionError extends Error {}

const canonicalRole = (role) => ROLES.get(String(role || '').trim().toLowerCase()) || null;

export const getSessionSecret = () => {
  const encoded = process.env.SESSION_SECRET || '';
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new SessionConfigurationError();
  }

  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== encoded) {
    throw new SessionConfigurationError();
  }

  return secret;
};

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const decode = (value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidSessionError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new InvalidSessionError();
  return JSON.parse(decoded.toString('utf8'));
};

const sign = (message, secret) =>
  crypto.createHmac('sha256', secret).update(message).digest();

export const createSessionToken = (user, { secret = getSessionSecret(), now = Date.now() } = {}) => {
  const role = canonicalRole(user?.role);
  if (!UUID_PATTERN.test(String(user?.id || '')) || !role) {
    throw new InvalidSessionError();
  }

  const issuedAt = Math.floor(now / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    sub: String(user.id).toLowerCase(),
    role,
    iat: issuedAt,
    exp: issuedAt + SESSION_LIFETIME_SECONDS,
    jti: crypto.randomUUID(),
  });
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret).toString('base64url')}`;
};

export const verifySessionToken = (token, { secret = getSessionSecret(), now = Date.now() } = {}) => {
  if (typeof token !== 'string' || token.length > 4096) throw new InvalidSessionError();
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidSessionError();

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decode(encodedHeader);
  if (
    !header ||
    header.alg !== 'HS256' ||
    header.typ !== 'JWT' ||
    Object.keys(header).some((key) => !['alg', 'typ'].includes(key))
  ) {
    throw new InvalidSessionError();
  }

  if (
    !/^[A-Za-z0-9_-]+$/.test(encodedSignature) ||
    Buffer.from(encodedSignature, 'base64url').toString('base64url') !== encodedSignature
  ) {
    throw new InvalidSessionError();
  }
  const signatureBytes = Buffer.from(encodedSignature, 'base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(signingInput, secret);
  if (
    signatureBytes.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(signatureBytes, expectedSignature)
  ) {
    throw new InvalidSessionError();
  }

  const claims = decode(encodedPayload);
  const role = canonicalRole(claims?.role);
  const nowSeconds = Math.floor(now / 1000);
  if (
    !claims ||
    claims.iss !== SESSION_ISSUER ||
    claims.aud !== SESSION_AUDIENCE ||
    !UUID_PATTERN.test(String(claims.sub || '')) ||
    !role ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > nowSeconds + 60 ||
    claims.exp <= nowSeconds ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > SESSION_LIFETIME_SECONDS ||
    !UUID_PATTERN.test(String(claims.jti || ''))
  ) {
    throw new InvalidSessionError();
  }

  return { ...claims, sub: claims.sub.toLowerCase(), role };
};

export const createRequireRoles = ({
  lookupUser = getAuthenticatedUserById,
  secretProvider = getSessionSecret,
  now = Date.now,
} = {}) => (...allowedRoles) => async (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return res.status(401).json({ error: 'Authentication required.', code: 'SESSION_INVALID' });
  }

  let claims;
  try {
    claims = verifySessionToken(match[1], { secret: secretProvider(), now: now() });
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
    }
    return res.status(401).json({ error: 'Authentication required.', code: 'SESSION_INVALID' });
  }

  let user;
  try {
    user = await lookupUser(claims.sub);
  } catch {
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }

  const currentRole = canonicalRole(user?.role);
  if (
    !user ||
    String(user.id || '').toLowerCase() !== claims.sub ||
    user.is_active !== true ||
    !currentRole ||
    currentRole !== claims.role
  ) {
    return res.status(401).json({ error: 'Authentication required.', code: 'SESSION_INVALID' });
  }

  req.auth = { sub: claims.sub, role: currentRole, jti: claims.jti };
  if (!allowedRoles.map(canonicalRole).includes(currentRole)) {
    return res.status(403).json({ error: 'You do not have access to this resource.' });
  }

  return next();
};

export const requireRoles = createRequireRoles();
