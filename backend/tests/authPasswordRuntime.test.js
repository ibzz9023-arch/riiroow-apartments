import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import test from 'node:test';

const tempDirectory = join(tmpdir(), `riiroow-login-check-${process.pid}-${Date.now()}`);
mkdirSync(tempDirectory, { recursive: true });

process.env.RIIROOW_DATA_FILE = join(tempDirectory, 'store.json');
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { loginUser } = await import('../src/dataService.js');

const testUser = {
  id: 'auth-test-user',
  name: 'Authentication Test',
  email: 'admin@riiroow.com',
  role: 'admin',
  permissions: ['all'],
};

const saveTestUser = (password) => {
  writeFileSync(process.env.RIIROOW_DATA_FILE, JSON.stringify({
    users: [{ ...testUser, password }],
    units: [],
    tenants: [],
    leases: [],
    payments: [],
    maintenance: [],
  }));
};

test('Argon2id login accepts the correct password and rejects a wrong one', async () => {
  const hash = await argon2.hash('correct-test-password', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

  saveTestUser(hash);

  const success = await loginUser({
    email: 'admin@riiroow.com',
    password: 'correct-test-password',
  });

  assert.ok(success, 'correct Argon2id password should log in');
  assert.equal(success.user.email, 'admin@riiroow.com');
  assert.equal(success.user.password, undefined);
  assert.equal(
    await loginUser({ email: 'admin@riiroow.com', password: 'wrong-password' }),
    null,
  );
});

test('legacy PBKDF2 passwords remain supported', async () => {
  const legacyHash = crypto
    .pbkdf2Sync('legacy-test-password', 'riiroow-apartments-v1', 100000, 64, 'sha512')
    .toString('hex');

  saveTestUser(legacyHash);

  const result = await loginUser({
    email: 'admin@riiroow.com',
    password: 'legacy-test-password',
  });

  assert.ok(result, 'legacy PBKDF2 password should still log in');
});
