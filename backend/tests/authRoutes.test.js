import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { mock } from 'node:test';

const secret = crypto.randomBytes(32);
process.env.SESSION_SECRET = secret.toString('base64url');
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const managerId = '550e8400-e29b-41d4-a716-446655440000';
const adminId = '550e8400-e29b-41d4-a716-446655440001';
const accountantId = '550e8400-e29b-41d4-a716-446655440002';
const users = new Map([
  [managerId, { id: managerId, role: 'Manager', is_active: true }],
  [adminId, { id: adminId, role: 'Admin', is_active: true }],
  [accountantId, { id: accountantId, role: 'Accountant', is_active: true }],
]);
const auditCalls = [];
const dataService = Object.fromEntries([
  'createEntity',
  'createLease',
  'createPayment',
  'createTenant',
  'deleteEntity',
  'getDashboard',
  'getLeases',
  'getMaintenance',
  'getPayments',
  'getTenants',
  'getTenantPayments',
  'getTenantPhotoRecord',
  'updateTenantPhotoStoragePath',
  'getUnits',
  'getUsers',
  'loginUser',
  'updateEntity',
  'updateLease',
  'updatePayment',
  'updateTenant',
  'terminateLease',
].map((name) => [name, async () => []]));
Object.assign(dataService, {
  getUsers: async () => [{
    id: managerId,
    name: 'Manager',
    email: 'manager@example.test',
    role: 'Manager',
    password: 'stored-password',
    password_hash: 'stored-password-hash',
  }],
  getAuthenticatedUserById: async (id) => users.get(id) || null,
  loginUser: async () => ({
    user: { id: managerId, name: 'Manager', role: 'Manager' },
    permissions: [],
  }),
  recordSecurityDepositTransaction: async (...args) => {
    auditCalls.push(['deposit', ...args]);
    return { id: 'deposit-1' };
  },
  getSecurityDepositSummary: async () => ({}),
});

mock.module(new URL('../src/dataService.js', import.meta.url).href, { exports: dataService });
mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: { hasSupabase: false, supabase: null, supabaseServiceRole: null },
});
mock.module(new URL('../src/paymentNotifications.js', import.meta.url).href, {
  exports: {
    submitTenantPaymentNotification: async () => ({ status: 201, body: {} }),
    listManagerPaymentNotifications: async () => [],
    reviewPaymentNotification: async (args) => {
      auditCalls.push(['payment', args]);
      return { status: 200, body: { success: true } };
    },
  },
});
mock.module(new URL('../src/moveOutRequests.js', import.meta.url).href, {
  exports: {
    submitTenantMoveOutRequest: async () => ({ status: 201, body: {} }),
    listManagerMoveOutRequests: async () => ({ status: 200, body: { requests: [] } }),
    reviewMoveOutRequest: async (args) => {
      auditCalls.push(['move-out', args]);
      return { status: 200, body: { success: true } };
    },
  },
});
mock.module(new URL('../src/tenantQrAuth.js', import.meta.url).href, {
  exports: {
    generateTenantPin: (req, res) => res.json({ success: true }),
    verifyTenantPin: (req, res) => res.json({ success: true }),
    requireTenantQrSession: (req, res, next) => {
      req.tenantQrAccess = {};
      next();
    },
  },
});

const { app } = await import('../server.js');
const { createSessionToken } = await import('../src/authSession.js');
const server = app.listen(0);
const baseUrl = await new Promise((resolve) => {
  server.once('listening', () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

const tokenFor = (id, role) => createSessionToken({ id, role }, { secret });
const request = (path, { token, method = 'GET', body } = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('valid manager and admin sessions reach manager routes with verified user identities', async () => {
  for (const [id, role] of [[managerId, 'Manager'], [adminId, 'Admin']]) {
    const response = await request('/api/manager/payment-notifications', {
      token: tokenFor(id, role),
    });
    assert.equal(response.status, 200);
  }
});

test('user list never returns password fields', async () => {
  const response = await request('/api/users', { token: tokenFor(managerId, 'Manager') });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: managerId,
    name: 'Manager',
    email: 'manager@example.test',
    role: 'Manager',
  });
  assert.equal(Object.keys(result[0]).some((key) => /password/i.test(key)), false);
});

test('login returns a signed token with the authenticated UUID, not a role-only token', async () => {
  const response = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'manager@example.test', password: 'valid-password' },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.user.id, managerId);
  assert.equal(result.token.startsWith('demo-token-'), false);

  const { verifySessionToken } = await import('../src/authSession.js');
  assert.equal(verifySessionToken(result.token, { secret }).sub, managerId);
});

test('missing, forged, and expired sessions cannot reach protected routes', async () => {
  assert.equal((await request('/api/manager/payment-notifications')).status, 401);
  assert.equal((await request('/api/manager/payment-notifications', {
    token: 'tenant-qr-session-opaque',
  })).status, 401);
  assert.equal((await request('/api/manager/payment-notifications', {
    token: 'demo-token-Manager',
  })).status, 401);
  assert.equal((await request('/api/manager/payment-notifications', {
    token: 'demo-token-Admin',
  })).status, 401);

  const expired = createSessionToken(
    { id: managerId, role: 'Manager' },
    { secret, now: Date.now() - 9 * 60 * 60 * 1000 },
  );
  assert.equal((await request('/api/manager/payment-notifications', { token: expired })).status, 401);
});

test('authorization boundaries reject accountants and managers from restricted routes', async () => {
  assert.equal((await request('/api/manager/payment-notifications', {
    token: tokenFor(accountantId, 'Accountant'),
  })).status, 403);
  assert.equal((await request('/api/units/unit-1', {
    method: 'DELETE',
    token: tokenFor(managerId, 'Manager'),
  })).status, 403);
});

test('review and deposit audit fields use the verified session ID, not body-supplied values', async () => {
  auditCalls.length = 0;
  const body = { action: 'VerifiedAuto', reviewNote: 'verified', reviewedBy: adminId, recordedBy: adminId };

  assert.equal((await request('/api/manager/payment-notifications/notification-1', {
    method: 'PATCH',
    token: tokenFor(managerId, 'Manager'),
    body,
  })).status, 200);
  assert.equal((await request('/api/manager/move-out-requests/request-1', {
    method: 'PATCH',
    token: tokenFor(managerId, 'Manager'),
    body: { action: 'Approved', reviewedBy: adminId },
  })).status, 200);
  assert.equal((await request('/api/leases/lease-1/security-deposits', {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    body: { transactionType: 'payment', amount: 10, recordedBy: adminId },
  })).status, 201);

  assert.equal(auditCalls[0][1].reviewedBy, managerId);
  assert.equal(auditCalls[1][1].reviewedBy, managerId);
  assert.equal(auditCalls[2][3], managerId);

  assert.equal((await request('/api/manager/payment-notifications/notification-2', {
    method: 'PATCH',
    token: tokenFor(adminId, 'Admin'),
    body: { action: 'Rejected', reviewedBy: managerId },
  })).status, 200);
  assert.equal(auditCalls[3][1].reviewedBy, adminId);
});

test('public tenant PIN verification remains independent of manager sessions', async () => {
  const response = await request('/api/public/qr/101/verify-pin', {
    method: 'POST',
    body: { pin: '1234' },
  });
  assert.equal(response.status, 200);
});
