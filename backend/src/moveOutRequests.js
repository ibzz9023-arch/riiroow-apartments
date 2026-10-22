import { supabaseServiceRole } from './supabaseClient.js';

const response = (status, body) => ({ status, body });
const getValue = (record, camelCase, snakeCase) => record?.[camelCase] ?? record?.[snakeCase] ?? null;
const sameId = (left, right) => String(left ?? '') === String(right ?? '');

const isDuplicatePendingError = (error) =>
  error?.code === '23505' && (
    error?.constraint === 'idx_move_out_requests_one_pending_per_lease' ||
    /idx_move_out_requests_one_pending_per_lease/i.test(String(error?.message || ''))
  );

export const submitTenantMoveOutRequest = async ({ access, requestedUnitNumber, body }) => {
  if (!access?.leaseId || !access?.tenantId || !access?.unitNumber || !access?.unitId) {
    return response(401, { error: 'A valid tenant QR session is required.' });
  }

  const requestedDate = String(body?.requestedMoveOutDate || '').trim();
  const reason = String(body?.reason || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return response(400, { error: 'Choose a valid requested move-out date.' });
  }

  const parsedDate = new Date(`${requestedDate}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== requestedDate) {
    return response(400, { error: 'Choose a valid requested move-out date.' });
  }
  if (requestedDate < new Date().toISOString().slice(0, 10)) {
    return response(400, { error: 'The requested move-out date cannot be in the past.' });
  }
  if (reason.length > 1000) {
    return response(400, { error: 'The reason must not exceed 1,000 characters.' });
  }
  if (String(requestedUnitNumber) !== String(access.unitNumber)) {
    return response(403, { error: 'The tenant session does not match this unit.' });
  }

  const [{ data: lease, error: leaseError }, { data: unit, error: unitError }] = await Promise.all([
    supabaseServiceRole.from('leases').select('*').eq('id', access.leaseId).maybeSingle(),
    supabaseServiceRole.from('units').select('*').eq('id', access.unitId).maybeSingle(),
  ]);
  if (leaseError || unitError) {
    return response(500, { error: 'Unable to verify the lease and unit for this request.' });
  }
  if (!lease || !unit) return response(404, { error: 'The lease or unit could not be found.' });

  const leaseTenantId = getValue(lease, 'tenantId', 'tenant_id');
  const leaseUnitId = getValue(lease, 'unitId', 'unit_id');
  const leasePropertyId = getValue(lease, 'propertyId', 'property_id');
  const unitPropertyId = getValue(unit, 'propertyId', 'property_id');
  const unitNumber = getValue(unit, 'unitNumber', 'unit_number');

  if (!sameId(leaseTenantId, access.tenantId)) {
    return response(403, { error: 'The tenant session does not match this lease.' });
  }
  if (String(lease.status || '').trim().toLowerCase() !== 'active') {
    return response(409, { error: 'A move-out request requires an active lease.' });
  }
  if (
    !sameId(leaseUnitId, access.unitId) ||
    !sameId(unit.id, access.unitId) ||
    !sameId(leasePropertyId, access.propertyId) ||
    !sameId(unitPropertyId, access.propertyId) ||
    Number(unitNumber) !== Number(access.unitNumber)
  ) {
    return response(403, { error: 'The lease does not match this unit and property.' });
  }

  const { data: existing, error: lookupError } = await supabaseServiceRole
    .from('move_out_requests')
    .select('id, status, requested_move_out_date, submitted_at')
    .eq('lease_id', String(lease.id))
    .eq('status', 'Pending Review')
    .maybeSingle();

  if (lookupError) {
    return response(500, { error: 'Unable to check existing move-out requests.' });
  }
  if (existing) {
    return response(409, {
      error: 'A move-out request for this lease is already awaiting review.',
      request: existing,
    });
  }

  const request = {
    lease_id: String(lease.id),
    tenant_id: String(access.tenantId),
    unit_id: String(access.unitId),
    property_id: access.propertyId,
    unit_number: Number(access.unitNumber),
    requested_move_out_date: requestedDate,
    reason: reason || null,
  };
  const { data, error } = await supabaseServiceRole
    .from('move_out_requests')
    .insert(request)
    .select('*')
    .single();

  if (isDuplicatePendingError(error)) {
    return response(409, {
      error: 'A move-out request for this lease is already awaiting review.',
      code: 'MOVE_OUT_REQUEST_PENDING',
    });
  }
  if (error) {
    console.error('Move-out request could not be saved:', error.message);
    return response(500, { error: 'Unable to submit the move-out request.' });
  }

  return response(201, {
    success: true,
    request: data,
    message: 'Your move-out request has been submitted for manager review.',
  });
};

// Manager: list move-out requests, newest submissions first.
export const listManagerMoveOutRequests = async () => {
  const { data, error } = await supabaseServiceRole
    .from('move_out_requests')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (error) {
    console.error('Unable to list move-out requests:', error.message);
    return response(500, { error: 'Unable to load move-out requests.' });
  }

  return response(200, { requests: data || [] });
};

// Manager: approve or reject a pending move-out request.
// This updates the request only; it does not terminate the lease.
export const reviewMoveOutRequest = async ({
  requestId,
  action,
  reviewNote,
  reviewedBy,
}) => {
  const normalizedAction = String(action || '').trim();
  if (!['Approved', 'Rejected'].includes(normalizedAction)) {
    return response(400, {
      error: 'Action must be Approved or Rejected.',
    });
  }

  const note = String(reviewNote || '').trim();
  if (note.length > 1000) {
    return response(400, {
      error: 'The review note must not exceed 1,000 characters.',
    });
  }

  const id = String(requestId || '').trim();
  if (!id) {
    return response(400, { error: 'A move-out request ID is required.' });
  }

  const { data, error } = await supabaseServiceRole
    .from('move_out_requests')
    .update({
      status: normalizedAction,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy || null,
      review_note: note || null,
    })
    .eq('id', id)
    .eq('status', 'Pending Review')
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('Unable to review move-out request:', error.message);
    return response(500, {
      error: 'Unable to review the move-out request.',
    });
  }

  if (!data) {
    const { data: existing, error: lookupError } = await supabaseServiceRole
      .from('move_out_requests')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) {
      return response(500, {
        error: 'Unable to verify the move-out request status.',
      });
    }

    if (!existing) {
      return response(404, { error: 'Move-out request not found.' });
    }

    return response(409, {
      error: 'This move-out request has already been reviewed.',
      status: existing.status,
    });
  }

  return response(200, {
    success: true,
    request: data,
    message: `Move-out request ${normalizedAction.toLowerCase()}.`,
  });
};
