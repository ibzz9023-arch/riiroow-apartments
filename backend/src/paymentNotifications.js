import { supabaseServiceRole } from './supabaseClient.js';
import { getLeases, getTenants, getUnits } from './dataService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFICATION_FIELDS = 'id, unit_number, amount, payment_method, transaction_reference, status, submitted_at';
const DUPLICATE_NOTIFICATION_FIELDS = 'id, tenant_id, unit_id, property_id, unit_number, amount, payment_method, transaction_reference, status, submitted_at';

const response = (status, body) => ({ status, body });

const isActiveLease = (lease) =>
  String(lease?.status || '').trim().toLowerCase() === 'active';

const getLeaseTenantId = (lease) => lease?.tenantId ?? lease?.tenant_id ?? null;
const getLeaseUnitId = (lease) => lease?.unitId ?? lease?.unit_id ?? null;
const getLeasePropertyId = (lease) => lease?.propertyId ?? lease?.property_id ?? null;
const getUnitNumber = (record) => Number(record?.unitNumber ?? record?.unit_number);
const getPropertyId = (record) => record?.propertyId ?? record?.property_id ?? null;

const matchesNotification = (existing, notification) =>
  String(existing.tenant_id) === notification.tenant_id &&
  String(existing.unit_id) === notification.unit_id &&
  String(existing.property_id ?? '') === String(notification.property_id ?? '') &&
  Number(existing.unit_number) === notification.unit_number &&
  Number(existing.amount) === notification.amount &&
  existing.payment_method === notification.payment_method &&
  (existing.transaction_reference ?? null) === notification.transaction_reference;

const getExistingNotification = async (leaseId, idempotencyKey) => {
  const { data, error } = await supabaseServiceRole
    .from('payment_notifications')
    .select(DUPLICATE_NOTIFICATION_FIELDS)
    .eq('lease_id', leaseId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw error;
  return data;
};

export const submitTenantPaymentNotification = async ({
  access,
  requestedUnitNumber,
  body,
  idempotencyKey,
}) => {
  if (!access?.leaseId || !access?.tenantId || !access?.unitNumber) {
    return response(401, { error: 'A valid tenant QR session is required.' });
  }

  if (!UUID_PATTERN.test(String(idempotencyKey || ''))) {
    return response(400, { error: 'A valid notification request key is required.' });
  }

  const amountText = String(body?.amount ?? '').trim();
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(\.\d{1,2})?$/.test(amountText)) {
    return response(400, { error: 'Enter a valid payment amount with up to two decimal places.' });
  }

  const paymentMethod = String(body?.paymentMethod || '').trim();
  if (!['Cash', 'Bank Transfer', 'Mobile Money', 'Other'].includes(paymentMethod)) {
    return response(400, { error: 'Choose a valid payment method.' });
  }

  const transactionReference = String(body?.transactionReference || '').trim();
  if (transactionReference.length > 200) {
    return response(400, { error: 'The transaction reference is too long.' });
  }

  const requestedUnit = Number(requestedUnitNumber);
  if (!Number.isInteger(requestedUnit) || requestedUnit !== Number(access.unitNumber)) {
    return response(403, { error: 'This session is not authorized for this unit.' });
  }

  const [leases, units] = await Promise.all([getLeases(), getUnits()]);
  const lease = (Array.isArray(leases) ? leases : []).find(
    (item) => String(item.id) === String(access.leaseId)
  );

  if (!lease || !isActiveLease(lease)) {
    return response(404, { error: 'The active lease could not be found.' });
  }

  if (String(getLeaseTenantId(lease) ?? '') !== String(access.tenantId)) {
    return response(403, { error: 'The tenant session does not match this lease.' });
  }

  const leaseUnitId = getLeaseUnitId(lease);
  const leasePropertyId = getLeasePropertyId(lease);
  if (
    (access.unitId && String(access.unitId) !== String(leaseUnitId ?? '')) ||
    (access.propertyId && String(access.propertyId) !== String(leasePropertyId ?? ''))
  ) {
    return response(403, { error: 'The tenant session no longer matches this unit and property.' });
  }
  const matchingUnits = (Array.isArray(units) ? units : []).filter((item) =>
    getUnitNumber(item) === requestedUnit &&
    (!leaseUnitId || String(item.id) === String(leaseUnitId)) &&
    (!leasePropertyId || String(getPropertyId(item) ?? '') === String(leasePropertyId))
  );

  if (matchingUnits.length !== 1) {
    return response(404, { error: 'The active lease or unit could not be found unambiguously.' });
  }

  const unit = matchingUnits[0];
  const notification = {
    lease_id: String(lease.id),
    tenant_id: String(access.tenantId),
    unit_id: String(leaseUnitId ?? unit.id),
    property_id: leasePropertyId ?? getPropertyId(unit),
    unit_number: requestedUnit,
    amount: Math.round(amount * 100) / 100,
    payment_method: paymentMethod,
    transaction_reference: transactionReference || null,
    idempotency_key: String(idempotencyKey).toLowerCase(),
  };

  if (!notification.unit_id) {
    return response(400, { error: 'The lease is missing valid unit information.' });
  }

  const { data, error } = await supabaseServiceRole
    .from('payment_notifications')
    .insert(notification)
    .select(NOTIFICATION_FIELDS)
    .single();

  if (!error) return response(201, { success: true, notification: data });

  if (error.code === '23505') {
    const existing = await getExistingNotification(notification.lease_id, notification.idempotency_key);
    if (existing && matchesNotification(existing, notification)) {
      return response(200, { success: true, duplicate: true, notification: existing });
    }
    if (existing) {
      return response(409, { error: 'This request key was already used for a different payment notification.' });
    }
  }

  console.error('QR payment notification could not be saved:', error.message);
  return response(500, { error: 'The payment notification could not be saved. Please try again later.' });
};

export const listManagerPaymentNotifications = async () => {
  const { data, error } = await supabaseServiceRole
    .from('payment_notifications')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (error) throw error;
  if (!data?.length) return [];

  const [leases, tenants] = await Promise.all([getLeases(), getTenants()]);
  return data.map((notification) => {
    const lease = (leases || []).find((item) =>
      String(item.id) === String(notification.lease_id) &&
      String(getLeaseTenantId(item) ?? '') === String(notification.tenant_id)
    );
    const tenant = lease && (tenants || []).find(
      (item) => String(item.id) === String(getLeaseTenantId(lease))
    );

    return { ...notification, tenant_name: tenant?.name ?? null };
  });
};

export const reviewPaymentNotification = async ({ notificationId, action, reviewNote, reviewedBy }) => {
  const normalizedAction = String(action || '').trim();
  const normalizedNote = String(reviewNote || '').trim();

  const allowedActions = ['VerifiedManual', 'VerifiedAuto', 'MarkManuallyRecorded', 'Rejected'];
  if (!allowedActions.includes(normalizedAction)) {
    return response(400, {
      error: 'Action must be VerifiedManual, VerifiedAuto, MarkManuallyRecorded, or Rejected.',
    });
  }
  if (normalizedNote.length > 1000) {
    return response(400, { error: 'The review note is too long.' });
  }

  const { data, error } = await supabaseServiceRole.rpc('review_payment_notification', {
    p_notification_id: notificationId,
    p_action: normalizedAction,
    p_reviewed_by: reviewedBy == null ? null : String(reviewedBy),
    p_review_note: normalizedNote || null,
  });

  if (!error) return response(200, data);

  const message = String(error.message || '');
  if (/not found/i.test(message)) return response(404, { error: 'Payment notification not found.' });
  if (/already been reviewed/i.test(message)) {
    return response(409, { error: 'This notification has already been reviewed.' });
  }
  if (/not awaiting rent recording/i.test(message)) {
    return response(409, { error: message });
  }
  if (/insufficient outstanding rent balance/i.test(message)) return response(409, { error: message });

  console.error('Payment notification review failed:', message);
  return response(500, { error: 'Unable to review this payment notification.' });
};
