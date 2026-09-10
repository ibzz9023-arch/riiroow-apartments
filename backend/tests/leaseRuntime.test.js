import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLease, terminateLease, updateLease } from '../src/dataService.js';

const storeFilePath = resolve(process.cwd(), 'backend/data/store.json');

const readStore = () => JSON.parse(readFileSync(storeFilePath, 'utf8'));

const restoreStore = (snapshot) => {
  writeFileSync(storeFilePath, JSON.stringify(snapshot, null, 2));
};

test('createLease stores a valid lease with security deposit and notes', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const testUnit = {
    id: 'lease-test-unit',
    unit_number: 998,
    floor: 1,
    bedrooms: 1,
    bathrooms: 1,
    rent: 1350,
    status: 'vacant',
    occupancy: 'Vacant',
    tenant_id: null,
  };

  original.units.push(testUnit);
  writeFileSync(storeFilePath, JSON.stringify(original, null, 2));

  const result = await createLease({
    tenant_id: 'tenant-101',
    unit_id: testUnit.id,
    unit_number: testUnit.unit_number,
    start_date: '2026-01-01',
    end_date: '2027-01-01',
    monthly_rent: 1350,
    security_deposit: 2700,
    status: 'Active',
    notes: 'Lease creation test',
  });

  assert.equal(result.securityDeposit, 2700);
  assert.equal(result.status, 'Active');
  assert.equal(result.notes, 'Lease creation test');

  const persisted = readStore();
  const savedLease = persisted.leases.find((entry) => entry.id === result.id);

  assert.ok(savedLease, 'Expected the lease to be persisted.');
  assert.equal(savedLease.security_deposit, 2700);
  assert.equal(savedLease.notes, 'Lease creation test');
});

test('createLease rejects conflicting active leases for the same unit', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const testUnit = {
    id: 'lease-conflict-test-unit',
    unit_number: 997,
    floor: 1,
    bedrooms: 1,
    bathrooms: 1,
    rent: 1500,
    status: 'occupied',
    occupancy: 'Occupied',
    tenant_id: 'tenant-101',
  };

  original.units.push(testUnit);

  original.leases.push({
    id: 'lease-conflict-test',
    tenant_id: 'tenant-101',
    unit_id: testUnit.id,
    unit_number: testUnit.unit_number,
    start_date: '2026-01-01',
    end_date: '2027-12-31',
    monthly_rent: 1500,
    security_deposit: 3000,
    status: 'Active',
    notes: 'Active conflict test lease',
  });

  writeFileSync(storeFilePath, JSON.stringify(original, null, 2));

  const error = await createLease({
    tenant_id: 'tenant-102',
    unit_id: testUnit.id,
    unit_number: testUnit.unit_number,
    start_date: '2026-02-01',
    end_date: '2027-02-01',
    monthly_rent: 1500,
    security_deposit: 3000,
    status: 'Active',
  }).then(() => null).catch((err) => err);

  assert.ok(error, 'Expected duplicate active lease creation to fail.');
  assert.equal(error.code, 'LEASE_VALIDATION');
  assert.match(error.message, /active lease/i);
});

test('updateLease and terminateLease keep lease data aligned with the runtime model', async (t) => {
  const original = readStore();
  t.after(() => restoreStore(original));

  const existingLease = original.leases.find((entry) => entry.id === 'lease-101');

  const updated = await updateLease(existingLease.id, {
    tenant_id: existingLease.tenantId || existingLease.tenant_id,
    unit_id: existingLease.unitId || existingLease.unit_id,
    unit_number: existingLease.unitNumber || existingLease.unit_number,
    start_date: existingLease.startDate || existingLease.start_date,
    end_date: existingLease.endDate || existingLease.end_date,
    monthly_rent: 1600,
    security_deposit: 3200,
    status: 'Active',
    notes: 'Updated lease notes',
  });

  assert.equal(updated.monthlyRent, 1600);
  assert.equal(updated.securityDeposit, 3200);
  assert.equal(updated.notes, 'Updated lease notes');

  const terminated = await terminateLease(existingLease.id, 'Lease ended per test');

  assert.equal(terminated.status, 'Terminated');
  assert.match(terminated.notes, /Lease ended per test/i);

  const persisted = readStore();
  const savedLease = persisted.leases.find((entry) => entry.id === existingLease.id);

  assert.equal(savedLease.status, 'Terminated');
  assert.match(savedLease.notes, /Lease ended per test/i);
});
