import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEASE_AGREEMENT_CLAUSES,
  LEASE_RENEWAL_STATEMENT,
  isLeaseRenewal,
} from '../../shared/leaseAgreementClauses.js';

test('all sixteen approved residential lease clauses are present in order', () => {
  assert.equal(LEASE_AGREEMENT_CLAUSES.length, 16);
  assert.equal(LEASE_AGREEMENT_CLAUSES[0].title, 'CLAUSE 1 – PURPOSE OF THE AGREEMENT');
  assert.equal(LEASE_AGREEMENT_CLAUSES[15].title, 'CLAUSE 16 – GENERAL CONDITIONS AND DISPUTE RESOLUTION');
  assert.ok(LEASE_AGREEMENT_CLAUSES.every((clause) => clause.title && clause.body));
});

test('renewal wording is included only for renewal records', () => {
  assert.equal(isLeaseRenewal({ notes: 'Lease renewed from 2026-11-30.' }), true);
  assert.equal(isLeaseRenewal({ notes: 'New lease agreement.' }), false);
  assert.equal(LEASE_RENEWAL_STATEMENT, 'This Lease Agreement is a renewal of the previous lease term.');
});
