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

export const getApprovalRequestOptions = async () => {
  const client = requireDatabase();
  const [propertiesResult, categoriesResult] = await Promise.all([
    client.from('properties').select('id, name').order('name', { ascending: true }),
    client.from('financial_expense_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
  ]);
  if (propertiesResult.error) throw propertiesResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  return {
    properties: propertiesResult.data || [],
    expenseCategories: categoriesResult.data || [],
  };
};

const mapReviewError = (error) => {
  const code = String(error?.code || '');
  const statusCode = ({
    '22023': 400,
    '22P02': 400,
    '42501': 403,
    'P0002': 404,
    '23505': 409,
    '23503': 409,
    '40001': 409,
  })[code] || 500;
  return Object.assign(
    new Error(error?.message || 'Unable to complete the approval decision.'),
    { statusCode, code: code || undefined }
  );
};

export const reviewApprovalRequest = async ({ requestId, action, reviewerId, reviewReason }) => {
  if (!['approve', 'reject'].includes(action)) {
    throw Object.assign(new Error('Choose approve or reject.'), { statusCode: 400 });
  }
  const reason = cleanText(reviewReason);
  if (action === 'reject' && (reason.length < 3 || reason.length > 2000)) {
    throw Object.assign(new Error('A written rejection reason between 3 and 2,000 characters is required.'), { statusCode: 400 });
  }

  // The database function locks the request, executes the requested operation,
  // and records the decision in one transaction. A failed operation rolls back
  // the decision, and concurrent Admin reviews cannot execute it twice.
  const { data, error } = await requireDatabase().rpc('review_approval_request', {
    p_request_id: requestId,
    p_action: action,
    p_reviewer_id: reviewerId,
    p_review_reason: reason || null,
  });
  if (error) throw mapReviewError(error);
  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('The approval decision returned no request record.'), { statusCode: 500 });
  }
  return toPublicRequest(data);
};
