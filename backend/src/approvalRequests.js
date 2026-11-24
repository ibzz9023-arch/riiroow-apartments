import { supabaseServiceRole } from './supabaseClient.js';

export const APPROVAL_REQUEST_TYPES = Object.freeze([
  'rent_change',
  'security_deposit_refund',
  'lease_termination',
  'exceptional_expense',
  'tenant_deletion',
]);

const cleanText = (value) => String(value ?? '').trim();
const serviceUnavailable = () => Object.assign(
  new Error('Approval requests require the Supabase service-role configuration.'),
  { statusCode: 503 }
);

const requireDatabase = () => {
  if (!supabaseServiceRole) throw serviceUnavailable();
  return supabaseServiceRole;
};

const toPublicRequest = (row) => ({
  id: row.id,
  requestType: row.request_type,
  title: row.title,
  reason: row.reason,
  details: row.details || {},
  status: row.status,
  requesterId: row.requester_id,
  reviewerId: row.reviewer_id,
  reviewReason: row.review_reason,
  submittedAt: row.submitted_at,
  reviewedAt: row.reviewed_at,
  updatedAt: row.updated_at,
});

export const submitApprovalRequest = async ({ requesterId, requestType, title, reason, details }) => {
  if (!APPROVAL_REQUEST_TYPES.includes(requestType)) {
    throw Object.assign(new Error('Choose a valid approval request type.'), { statusCode: 400 });
  }
  const cleanTitle = cleanText(title);
  const cleanReason = cleanText(reason);
  if (cleanTitle.length < 3 || cleanTitle.length > 200) {
    throw Object.assign(new Error('Request title must be between 3 and 200 characters.'), { statusCode: 400 });
  }
  if (cleanReason.length < 3 || cleanReason.length > 2000) {
    throw Object.assign(new Error('A reason between 3 and 2,000 characters is required.'), { statusCode: 400 });
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw Object.assign(new Error('Request details must be an object.'), { statusCode: 400 });
  }

  const { data, error } = await requireDatabase()
    .from('approval_requests')
    .insert([{
      request_type: requestType,
      title: cleanTitle,
      reason: cleanReason,
      details,
      requester_id: requesterId,
    }])
    .select('*')
    .single();
  if (error) throw error;
  return toPublicRequest(data);
};

export const listApprovalRequests = async ({ requesterId = null } = {}) => {
  let query = requireDatabase()
    .from('approval_requests')
    .select('*')
    .order('submitted_at', { ascending: false });
  if (requesterId) query = query.eq('requester_id', requesterId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(toPublicRequest);
};

export const reviewApprovalRequest = async ({ requestId, action, reviewerId, reviewReason, onApprove }) => {
  if (!['approve', 'reject'].includes(action)) {
    throw Object.assign(new Error('Choose approve or reject.'), { statusCode: 400 });
  }
  const reason = cleanText(reviewReason);
  if (action === 'reject' && (reason.length < 3 || reason.length > 2000)) {
    throw Object.assign(new Error('A written rejection reason between 3 and 2,000 characters is required.'), { statusCode: 400 });
  }

  const client = requireDatabase();
  const { data: current, error: readError } = await client
    .from('approval_requests')
    .select('id, status, requester_id, request_type, details, reason')
    .eq('id', requestId)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) throw Object.assign(new Error('Approval request not found.'), { statusCode: 404 });
  if (current.requester_id === reviewerId) {
    throw Object.assign(new Error('You cannot approve or reject your own request.'), { statusCode: 403 });
  }
  if (current.status !== 'pending') {
    throw Object.assign(new Error('This request has already been reviewed.'), { statusCode: 409 });
  }

  // Complete the requested business action before recording approval. If the
  // operation fails, the request stays pending instead of showing a false approval.
  if (action === 'approve' && typeof onApprove === 'function') {
    await onApprove({
      requestType: current.request_type,
      details: current.details || {},
      reason: current.reason || '',
    });
  }

  const { data, error } = await client
    .from('approval_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewer_id: reviewerId,
      review_reason: action === 'reject' ? reason : (reason || null),
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .neq('requester_id', reviewerId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error('The request was already reviewed or could not be updated.'), { statusCode: 409 });
  }
  return toPublicRequest(data);
};
