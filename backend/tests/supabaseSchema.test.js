import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const schema = readFileSync(resolve(process.cwd(), 'src/supabaseSchema.sql'), 'utf8');

test('payments schema supports partial payment tracking', () => {
  assert.match(schema, /create table if not exists payments \(/);
  assert.match(schema, /paid_amount\s+numeric\s+not null\s+default\s+0/);
  assert.match(schema, /status text not null default 'Outstanding' check \(status in \('Paid','Outstanding','Overdue','Partially Paid'\)\)/);
});
