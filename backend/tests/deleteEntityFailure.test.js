import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tempDirectory = join(
  tmpdir(),
  `riiroow-delete-failure-tests-${process.pid}-${Date.now()}`
);
const storeFilePath = join(tempDirectory, 'store.json');

// Use a deliberately unreachable local endpoint.
// This test must never connect to the production database.
process.env.RIIROOW_DATA_FILE = storeFilePath;
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'local-regression-test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { hasSupabase } = await import('../src/supabaseClient.js');

assert.equal(
  hasSupabase,
  true,
  'The test requires a configured Supabase client pointed at its local test endpoint.'
);

const { seedState } = await import('../src/store.js');
const { deleteEntity } = await import('../src/dataService.js');

mkdirSync(tempDirectory, { recursive: true });

const initialState = seedState();
writeFileSync(storeFilePath, JSON.stringify(initialState, null, 2));

test.after(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('failed Supabase deletion propagates the error without changing local data', async () => {
  const before = readFileSync(storeFilePath, 'utf8');
  const existingLease = initialState.leases[0];

  assert.ok(existingLease, 'Expected a lease in the synthetic test fixture.');

  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      deleteEntity('leases', existingLease.id),
      'A failed Supabase deletion must reject instead of silently falling back.'
    );
  } finally {
    console.error = originalConsoleError;
  }

  const after = readFileSync(storeFilePath, 'utf8');

  assert.equal(
    after,
    before,
    'The local data file must remain unchanged after a Supabase deletion failure.'
  );
});
