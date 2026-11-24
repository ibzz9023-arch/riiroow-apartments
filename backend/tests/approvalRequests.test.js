import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rpcCalls = [];
let rpcResponse = {
  data: {
    id: 'request-1',
    request_type: 'rent_change',
    title: 'Change rent',
    reason: 'Approved adjustment',
    details: { target: 'unit' },
    status: 'approved',
    requester_id: 'manager-1',
    reviewer_id: 'admin-1',
    review_reason: null,
    submitted_at: '2026-11-24T10:00:00.000Z',
    reviewed_at: '2026-11-24T11:00:00.000Z',
    updated_at: '2026-11-24T11:00:00.000Z',
  },
  error: null,
};
const fakeServiceRole = {
  async rpc(name, parameters) {
    rpcCalls.push({ name, parameters });
    return rpcResponse;
  },
};

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: {
    supabase: null,
    hasSupabase: false,
    supabaseServiceRole: fakeServiceRole,
  },
});

const { reviewApprovalRequest } = await import('../src/approvalRequests.js');

test('approval and rejection are delegated to the atomic database operation', async () => {
  rpcCalls.length = 0;
  rpcResponse.error = null;

  const approved = await reviewApprovalRequest({
    requestId: 'request-1',
    action: 'approve',
    reviewerId: 'admin-1',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(rpcCalls[0].name, 'review_approval_request');
  assert.deepEqual(rpcCalls[0].parameters, {
    p_request_id: 'request-1',
    p_action: 'approve',
    p_reviewer_id: 'admin-1',
    p_review_reason: null,
  });

  rpcCalls.length = 0;
  rpcResponse.data = { ...rpcResponse.data, status: 'rejected', review_reason: 'Insufficient evidence' };
  const rejected = await reviewApprovalRequest({
    requestId: 'request-1',
    action: 'reject',
    reviewerId: 'admin-1',
    reviewReason: 'Insufficient evidence',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rpcCalls[0].parameters.p_action, 'reject');
  assert.equal(rpcCalls[0].parameters.p_review_reason, 'Insufficient evidence');
});

test('rejection requires a written reason before calling the database', async () => {
  rpcCalls.length = 0;
  await assert.rejects(
    reviewApprovalRequest({
      requestId: 'request-1',
      action: 'reject',
      reviewerId: 'admin-1',
      reviewReason: '  ',
    }),
    (error) => error.statusCode === 400
  );
  assert.equal(rpcCalls.length, 0);
});

test('database review errors preserve safe HTTP status mapping', async () => {
  rpcResponse.error = { code: '40001', message: 'The rent changed concurrently.' };
  await assert.rejects(
    reviewApprovalRequest({
      requestId: 'request-1',
      action: 'approve',
      reviewerId: 'admin-1',
    }),
    (error) => error.statusCode === 409 && /changed concurrently/.test(error.message)
  );
  rpcResponse.error = null;
});

test('atomic approval migration locks each request and handles every supported action type', () => {
  const migration = readFileSync(
    new URL('../migrations/202611240003_atomic_approval_actions.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /FROM public\.approval_requests\s+WHERE id = p_request_id\s+FOR UPDATE/i);
  assert.match(migration, /WHEN 'rent_change'/i);
  assert.match(migration, /WHEN 'security_deposit_refund'/i);
  assert.match(migration, /WHEN 'lease_termination'/i);
  assert.match(migration, /WHEN 'exceptional_expense'/i);
  assert.match(migration, /WHEN 'tenant_deletion'/i);
  assert.match(migration, /WHEN p_action = 'reject'|IF p_action = 'reject'/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.review_approval_request/i);
  assert.match(migration, /record_security_deposit_transaction/i);
  assert.match(migration, /create_financial_expense/i);
  assert.match(migration, /public\.maintenance_requests WHERE tenant_id = v_target_id/i);
  assert.match(migration, /public\.rent_legacy_balances WHERE tenant_id = v_target_id/i);
  assert.match(migration, /Historical approved lease termination request\(s\)/i);
});
