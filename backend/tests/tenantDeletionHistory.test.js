import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tempDirectory = join(tmpdir(), `riiroow-tenant-history-tests-${process.pid}-${Date.now()}`);
const storeFilePath = join(tempDirectory, 'store.json');

process.env.RIIROOW_DATA_FILE = storeFilePath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { seedState } = await import('../src/store.js');
const { deleteEntity } = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });

const initialState = seedState();
const lease = initialState.leases[0];

assert.ok(lease, 'Expected a lease in the synthetic test fixture.');

const tenantId = lease.tenantId ?? lease.tenant_id;
const tenant = initialState.tenants.find(
  (entry) => String(entry.id) === String(tenantId),
);

assert.ok(tenant, 'Expected to find the tenant associated with the fixture lease.');

writeFileSync(storeFilePath, JSON.stringify(initialState, null, 2));

test.after(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('tenant with lease history cannot be deleted and local data remains unchanged', async () => {
  const before = readFileSync(storeFilePath, 'utf8');

  await assert.rejects(
    deleteEntity('tenants', tenant.id),
    (error) => {
      assert.equal(error.code, 'TENANT_HAS_HISTORY');
      assert.match(error.message, /lease or payment history/i);
      return true;
    },
  );

  const after = readFileSync(storeFilePath, 'utf8');
  assert.equal(after, before, 'The stored data must remain unchanged.');
});