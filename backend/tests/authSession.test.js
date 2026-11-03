import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  createRequireRoles,
  createSessionToken,
  getSessionSecret,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  SESSION_LIFETIME_SECONDS,
  SessionConfigurationError,
  verifySessionToken,
} from '../src/authSession.js';

const secret = crypto.randomBytes(32);
const user = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  role: 'Manager',
  is_active: true,
};

const signClaims = (claims, signingSecret = secret, header = { alg: 'HS256', typ: 'JWT' }) => {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = crypto.createHmac('sha256', signingSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
};

const validClaims = (overrides = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    sub: user.id,
    role: user.role,
    iat: now,
    exp: now + SESSION_LIFETIME_SECONDS,
    jti: crypto.randomUUID(),
    ...overrides,
  };
};

const invoke = async (middleware, authorization) => {
  const req = { headers: authorization ? { authorization } : {} };
  let status = 200;
  let body;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  await middleware(req, res, () => {
    body = { auth: req.auth };
  });
  return { status, body };
};

test('signed sessions carry the user identity and fixed eight-hour claims', () => {
  const token = createSessionToken(user, { secret });
  const claims = verifySessionToken(token, { secret });

  assert.equal(claims.sub, user.id);
  assert.equal(claims.role, 'Manager');
  assert.equal(claims.iss, SESSION_ISSUER);
  assert.equal(claims.aud, SESSION_AUDIENCE);
  assert.equal(claims.exp - claims.iat, SESSION_LIFETIME_SECONDS);
  assert.match(claims.jti, /^[0-9a-f-]{36}$/i);
});

test('modified tokens, incorrect signatures, and unsigned demo tokens are rejected', () => {
  const token = createSessionToken(user, { secret });
  const [header, payload, signature] = token.split('.');
  const modifiedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;

  assert.throws(() => verifySessionToken(`${header}.${modifiedPayload}.${signature}`, { secret }));
  assert.throws(() => verifySessionToken(token, { secret: crypto.randomBytes(32) }));
  assert.throws(() => verifySessionToken('demo-token-Manager', { secret }));
  assert.throws(() => verifySessionToken('demo-token-Admin', { secret }));
});

test('expired or incorrectly scoped sessions are rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.throws(() => verifySessionToken(signClaims(validClaims({
    iat: now - SESSION_LIFETIME_SECONDS,
    exp: now - 1,
  })), { secret }));
  assert.throws(() => verifySessionToken(signClaims(validClaims({ iss: 'other-issuer' })), { secret }));
  assert.throws(() => verifySessionToken(signClaims(validClaims({ aud: 'other-audience' })), { secret }));
});

test('invalid UUIDs, unknown roles, and unsupported algorithms are rejected', () => {
  assert.throws(() => createSessionToken({ ...user, id: 'manager-1' }, { secret }));
  assert.throws(() => createSessionToken({ ...user, role: 'Owner' }, { secret }));
  assert.throws(() => verifySessionToken(signClaims(validClaims({ sub: 'not-a-uuid' })), { secret }));
  assert.throws(() => verifySessionToken(signClaims(validClaims({ role: 'Owner' })), { secret }));
  assert.throws(() => verifySessionToken(
    signClaims(validClaims(), secret, { alg: 'none', typ: 'JWT' }),
    { secret },
  ));
});

test('missing, weak, or malformed SESSION_SECRET fails closed', () => {
  const original = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    assert.throws(getSessionSecret, SessionConfigurationError);
    process.env.SESSION_SECRET = crypto.randomBytes(31).toString('base64url');
    assert.throws(getSessionSecret, SessionConfigurationError);
    process.env.SESSION_SECRET = 'not-a-valid-key!';
    assert.throws(getSessionSecret, SessionConfigurationError);
  } finally {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  }
});

test('authentication rejects missing, inactive, changed-role, and insufficient-role sessions', async () => {
  const middleware = createRequireRoles({
    lookupUser: async () => user,
    secretProvider: () => secret,
  });
  assert.equal((await invoke(middleware('Manager'))).status, 401);

  const validToken = createSessionToken(user, { secret });
  assert.equal((await invoke(middleware('Manager'), `Bearer ${validToken}`)).status, 200);
  assert.equal((await invoke(middleware('Admin'), `Bearer ${validToken}`)).status, 403);

  const inactive = createRequireRoles({
    lookupUser: async () => ({ ...user, is_active: false }),
    secretProvider: () => secret,
  });
  assert.equal((await invoke(inactive('Manager'), `Bearer ${validToken}`)).status, 401);

  const changedRole = createRequireRoles({
    lookupUser: async () => ({ ...user, role: 'Admin' }),
    secretProvider: () => secret,
  });
  assert.equal((await invoke(changedRole('Admin'), `Bearer ${validToken}`)).status, 401);
});

test('identity lookup failures fail closed without authorizing the request', async () => {
  const middleware = createRequireRoles({
    lookupUser: async () => { throw new Error('database unavailable'); },
    secretProvider: () => secret,
  });
  const token = createSessionToken(user, { secret });
  assert.equal((await invoke(middleware('Manager'), `Bearer ${token}`)).status, 503);

  const missingSecret = createRequireRoles({
    lookupUser: async () => user,
    secretProvider: () => { throw new SessionConfigurationError(); },
  });
  assert.equal((await invoke(missingSecret('Manager'), `Bearer ${token}`)).status, 503);
});
