import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/store.js';

test('demo seed covers all units and multiple lease periods', () => {
  const { units, tenants, leases } = seedState();

  assert.equal(units.length, 10);
  assert.equal(leases.length, 10);
  assert.equal(tenants.length, 11);
  assert.deepEqual(new Set(units.map((unit) => unit.unitNumber)).size, 10);
  assert.ok(leases.every((lease) => lease.startDate < lease.endDate));
  assert.ok(tenants.every((tenant) => tenant.name.startsWith('Demo Tenant')));
  assert.ok(tenants.some((tenant) => !leases.some((lease) => lease.tenantId === tenant.id)));
});

test('demo seed has payment states, metadata, and a payment outside its lease', () => {
  const { leases, payments } = seedState();
  const statuses = new Set(payments.map((payment) => payment.status));

  assert.ok(statuses.has('Paid'));
  assert.ok(statuses.has('Partially Paid'));
  assert.ok(statuses.has('Overdue'));
  assert.ok(statuses.has('Outstanding'));
  assert.ok(payments.every((payment) => payment.dueDate && payment.method && payment.notes && payment.reference));
  assert.ok(payments.some((payment) => payment.paidDate));
  assert.ok(payments.some((payment) => !payment.paidDate && payment.paidAmount === 0));
  assert.ok(!payments.some((payment) => payment.tenantId === 'tenant-101' && payment.dueDate.startsWith('2026-03')));

  const outsideLeasePayment = payments.find((payment) => {
    const lease = leases.find((entry) => entry.tenantId === payment.tenantId);
    return lease && (payment.dueDate < lease.startDate || payment.dueDate > lease.endDate);
  });

  assert.equal(outsideLeasePayment?.id, 'demo-pay-501-prior-lease');
});