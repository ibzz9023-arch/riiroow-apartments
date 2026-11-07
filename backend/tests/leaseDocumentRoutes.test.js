import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { mock } from 'node:test';

const secret = crypto.randomBytes(32);
process.env.SESSION_SECRET = secret.toString('base64url');
process.env.LEASE_DOCUMENT_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const managerId = '550e8400-e29b-41d4-a716-446655440000';
const adminId = '550e8400-e29b-41d4-a716-446655440001';
const accountantId = '550e8400-e29b-41d4-a716-446655440002';
const leaseId = '650e8400-e29b-41d4-a716-446655440000';
const secondLeaseId = '650e8400-e29b-41d4-a716-446655440001';

const users = new Map([
  [managerId, { id: managerId, role: 'Manager', is_active: true }],
  [adminId, { id: adminId, role: 'Admin', is_active: true }],
  [accountantId, { id: accountantId, role: 'Accountant', is_active: true }],
]);

const state = {
  leases: new Map([
    [leaseId, { id: leaseId }],
    [secondLeaseId, { id: secondLeaseId }],
  ]),
  documents: [],
  access: [],
  objects: new Map(),
  failDocumentInsert: false,
};

const matches = (row, filters) => filters.every(({ method, field, value }) => {
  if (method === 'is') return row[field] === value;
  return String(row[field]) === String(value);
});

class Query {
  constructor(table) {
    this.table = table;
    this.action = 'select';
    this.payload = null;
    this.filters = [];
    this.single = false;
    this.sort = null;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.filters.push({ method: 'eq', field, value });
    return this;
  }

  is(field, value) {
    this.filters.push({ method: 'is', field, value });
    return this;
  }

  order(field, options = {}) {
    this.sort = { field, ascending: options.ascending !== false };
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this.execute();
  }

  insert(payload) {
    this.action = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.action = 'update';
    this.payload = payload;
    return this;
  }

  async execute() {
    if (this.action === 'insert') {
      if (this.table === 'lease_documents' && state.failDocumentInsert) {
        state.failDocumentInsert = false;
        return { data: null, error: { message: 'Simulated metadata failure.' } };
      }

      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];

      if (this.table === 'lease_document_access') {
        if (rows.some((row) => state.access.some((item) => item.lease_id === row.lease_id))) {
          return { data: null, error: { code: '23505', message: 'Duplicate access row.' } };
        }
        state.access.push(...structuredClone(rows));
      } else if (this.table === 'lease_documents') {
        state.documents.push(...structuredClone(rows));
      }

      return { data: null, error: null };
    }

    let rows;
    if (this.table === 'leases') rows = [...state.leases.values()];
    else if (this.table === 'lease_documents') rows = state.documents;
    else if (this.table === 'lease_document_access') rows = state.access;
    else rows = [];

    rows = rows.filter((row) => matches(row, this.filters));

    if (this.action === 'update') {
      for (const row of rows) Object.assign(row, structuredClone(this.payload));
    }

    if (this.sort) {
      const direction = this.sort.ascending ? 1 : -1;
      rows = [...rows].sort((a, b) =>
        direction * String(a[this.sort.field] || '').localeCompare(String(b[this.sort.field] || ''))
      );
    }

    return {
      data: this.single ? (rows[0] || null) : rows,
      error: null,
    };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

const storage = {
  from(bucketName) {
    assert.equal(bucketName, 'lease-documents');

    return {
      async upload(path, buffer, options) {
        state.objects.set(path, {
          buffer: Buffer.from(buffer),
          contentType: options.contentType,
        });
        return { data: { path }, error: null };
      },

      async remove(paths) {
        for (const path of paths) state.objects.delete(path);
        return { data: paths, error: null };
      },

      async createSignedUrl(path, expiresIn, options) {
        assert.ok(state.objects.has(path), `Expected stored object: ${path}`);
        assert.equal(expiresIn, 600);
        return {
          data: {
            signedUrl: `https://storage.test/${encodeURIComponent(path)}?expires=${expiresIn}${options?.download ? '&download=1' : ''}`,
          },
          error: null,
        };
      },
    };
  },
};

const supabaseServiceRole = {
  from(table) {
    return new Query(table);
  },
  storage,
};

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
  getAuthenticatedUserById: async (id) => users.get(id) || null,
});

mock.module(new URL('../src/dataService.js', import.meta.url).href, {
  exports: dataService,
});

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: {
    hasSupabase: true,
    supabase: null,
    supabaseServiceRole,
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

test.beforeEach(() => {
  state.documents = [];
  state.access = [];
  state.objects.clear();
  state.failDocumentInsert = false;
});

const tokenFor = (id, role) =>
  createSessionToken({ id, role }, { secret });

const request = (path, { token, method = 'GET', body, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: form } : {}),
  });
};

const validPdf = Buffer.from('%PDF-1.4\nRiiroow lease test document\n');

const uploadForm = (buffer = validPdf, {
  filename = 'lease.pdf',
  mimeType = 'application/pdf',
} = {}) => {
  const form = new FormData();
  form.append('documents', new Blob([buffer], { type: mimeType }), filename);
  return form;
};

const getAccessToken = async (userId = managerId, role = 'Manager', id = leaseId) => {
  const response = await request(`/api/leases/${id}/documents/access`, {
    method: 'POST',
    token: tokenFor(userId, role),
    body: {},
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
};

test('document upload requires authentication', async () => {
  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    form: uploadForm(),
  });

  assert.equal(response.status, 401);
  assert.equal(state.documents.length, 0);
  assert.equal(state.objects.size, 0);
});

test('Accountant cannot upload lease documents', async () => {
  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    token: tokenFor(accountantId, 'Accountant'),
    form: uploadForm(),
  });

  assert.equal(response.status, 403);
  assert.equal(state.documents.length, 0);
  assert.equal(state.objects.size, 0);
});

test('Manager can upload a valid PDF to private storage with lease metadata', async () => {
  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    form: uploadForm(validPdf, { filename: 'signed-lease.pdf' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { success: true, uploaded: 1 });
  assert.equal(state.documents.length, 1);
  assert.equal(state.objects.size, 1);

  const document = state.documents[0];
  assert.equal(document.lease_id, leaseId);
  assert.equal(document.original_name, 'signed-lease.pdf');
  assert.equal(document.mime_type, 'application/pdf');
  assert.equal(document.created_by, managerId);
  assert.ok(document.storage_path.startsWith(`${leaseId}/`));
  assert.ok(!document.storage_path.includes('signed-lease.pdf'));
});

test('upload rejects a file whose content does not match its claimed MIME type', async () => {
  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    form: uploadForm(Buffer.from('not a PDF'), {
      filename: 'fake.pdf',
      mimeType: 'application/pdf',
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(state.documents.length, 0);
  assert.equal(state.objects.size, 0);
});

test('upload rejects unsupported MIME types', async () => {
  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    form: uploadForm(Buffer.from('plain text'), {
      filename: 'notes.txt',
      mimeType: 'text/plain',
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(state.documents.length, 0);
  assert.equal(state.objects.size, 0);
});

test('failed metadata insertion triggers private storage cleanup', async () => {
  state.failDocumentInsert = true;

  const response = await request(`/api/leases/${leaseId}/documents`, {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    form: uploadForm(),
  });

  assert.equal(response.status, 500);
  assert.equal(state.documents.length, 0);
  assert.equal(state.objects.size, 0);
});

test('public QR access returns only documents belonging to its lease', async () => {
  for (const id of [leaseId, secondLeaseId]) {
    const response = await request(`/api/leases/${id}/documents`, {
      method: 'GET',
      token: tokenFor(managerId, 'Manager'),
    });
    assert.equal(response.status, 200);
  }

  for (const id of [leaseId, secondLeaseId]) {
    const response = await request(`/api/leases/${id}/documents`, {
      method: 'POST',
      token: tokenFor(managerId, 'Manager'),
      form: uploadForm(),
    });
    assert.equal(response.status, 201);
  }

  const firstToken = await getAccessToken(managerId, 'Manager', leaseId);
  const response = await request(`/api/public/lease-documents/${firstToken}`);
  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].originalName, 'lease.pdf');
  assert.ok(result.documents[0].previewUrl.startsWith('https://storage.test/'));
  assert.ok(result.documents[0].downloadUrl.startsWith('https://storage.test/'));
  assert.equal(JSON.stringify(result).includes('storage_path'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('malformed and unknown public tokens are rejected', async () => {
  const malformed = await request('/api/public/lease-documents/not-a-valid-token');
  assert.equal(malformed.status, 404);

  const unknownToken = crypto.randomBytes(32).toString('base64url');
  const unknown = await request(`/api/public/lease-documents/${unknownToken}`);
  assert.equal(unknown.status, 404);
});

test('Accountant can retrieve an existing link but cannot regenerate or revoke it', async () => {
  const existingToken = await getAccessToken();

  const readResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'POST',
    token: tokenFor(accountantId, 'Accountant'),
    body: {},
  });
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json()).token, existingToken);

  const regenerateResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'POST',
    token: tokenFor(accountantId, 'Accountant'),
    body: { regenerate: true },
  });
  assert.equal(regenerateResponse.status, 403);

  const revokeResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'DELETE',
    token: tokenFor(accountantId, 'Accountant'),
  });
  assert.equal(revokeResponse.status, 403);

  const missingLinkResponse = await request(`/api/leases/${secondLeaseId}/documents/access`, {
    method: 'POST',
    token: tokenFor(accountantId, 'Accountant'),
    body: {},
  });
  assert.equal(missingLinkResponse.status, 404);
  assert.equal(state.access.some((item) => item.lease_id === secondLeaseId), false);
});

test('revocation blocks public access and management can regenerate a new link', async () => {
  const originalToken = await getAccessToken();

  const revokeResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'DELETE',
    token: tokenFor(managerId, 'Manager'),
  });
  assert.equal(revokeResponse.status, 200);

  const blockedResponse = await request(`/api/public/lease-documents/${originalToken}`);
  assert.equal(blockedResponse.status, 404);

  const revokedAccessResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'POST',
    token: tokenFor(managerId, 'Manager'),
    body: {},
  });
  assert.equal(revokedAccessResponse.status, 409);

  const regenerateResponse = await request(`/api/leases/${leaseId}/documents/access`, {
    method: 'POST',
    token: tokenFor(adminId, 'Admin'),
    body: { regenerate: true },
  });
  assert.equal(regenerateResponse.status, 200);

  const newToken = (await regenerateResponse.json()).token;
  assert.notEqual(newToken, originalToken);

  const oldTokenResponse = await request(`/api/public/lease-documents/${originalToken}`);
  assert.equal(oldTokenResponse.status, 404);

  const newTokenResponse = await request(`/api/public/lease-documents/${newToken}`);
  assert.equal(newTokenResponse.status, 200);
});

test('lease document list is restricted to the requested lease', async () => {
  for (const id of [leaseId, secondLeaseId]) {
    const response = await request(`/api/leases/${id}/documents`, {
      method: 'GET',
      token: tokenFor(managerId, 'Manager'),
    });
    assert.equal(response.status, 200);
  }

  for (const id of [leaseId, secondLeaseId]) {
    const response = await request(`/api/leases/${id}/documents`, {
      method: 'POST',
      token: tokenFor(managerId, 'Manager'),
      form: uploadForm(),
    });
    assert.equal(response.status, 201);
  }

  const response = await request(`/api/leases/${leaseId}/documents`, {
    token: tokenFor(managerId, 'Manager'),
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.documents.length, 1);
  assert.equal(result.access.enabled, false);
});

test('invalid lease IDs do not expose lease documents', async () => {
  const response = await request('/api/leases/not-a-uuid/documents', {
    token: tokenFor(managerId, 'Manager'),
  });

  assert.equal(response.status, 404);
});
