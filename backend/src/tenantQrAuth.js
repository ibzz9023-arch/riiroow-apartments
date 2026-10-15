import crypto from 'node:crypto';
import argon2 from 'argon2';
import { supabaseServiceRole as supabase } from './supabaseClient.js';
import { getLeases } from './dataService.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

const getPinPepper = () => {
  const pepper = process.env.RIIROOW_TENANT_PIN_PEPPER || '';

  if (Buffer.byteLength(pepper, 'utf8') < 32) {
    throw new Error('Tenant PIN pepper is missing or insufficiently long.');
  }

  return pepper;
};

const hashPinInput = (pin) =>
  crypto
    .createHmac('sha256', getPinPepper())
    .update(pin, 'utf8')
    .digest('hex');

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_ATTEMPTS = 10;
const IP_MAX_BUCKETS = 10000;
const ipRateLimitBuckets = new Map();

const getClientIp = (req) => {
  // Use Express's resolved IP. Do not trust arbitrary forwarded headers here.
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100);
};

const isIpRateLimited = (req) => {
  const now = Date.now();
  const ip = getClientIp(req);
  let bucket = ipRateLimitBuckets.get(ip);

  if (!bucket || now - bucket.startedAt >= IP_WINDOW_MS) {
    bucket = { startedAt: now, attempts: 0 };
    ipRateLimitBuckets.set(ip, bucket);
  }

  bucket.attempts += 1;

  // Keep memory bounded if many different IPs contact this endpoint.
  if (ipRateLimitBuckets.size > IP_MAX_BUCKETS) {
    for (const [key, value] of ipRateLimitBuckets) {
      if (now - value.startedAt >= IP_WINDOW_MS) {
        ipRateLimitBuckets.delete(key);
      }
    }

    if (ipRateLimitBuckets.size > IP_MAX_BUCKETS) {
      return true;
    }
  }

  return bucket.attempts > IP_MAX_ATTEMPTS;
};

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const getUnitNumber = (lease) =>
  Number(lease?.unitNumber ?? lease?.unit_number);

const isActiveLease = (lease) =>
  String(lease?.status || '').trim().toLowerCase() === 'active';

const findActiveLease = async (leaseId) => {
  const leases = await getLeases();

  return leases.find(
    (lease) =>
      String(lease.id) === String(leaseId) &&
      isActiveLease(lease)
  );
};

/**
 * Manager-only route handler.
 * Mount behind the existing requireRoles('Admin', 'Manager') middleware.
 * The raw PIN is returned once and must be shared privately with the tenant.
 */
export const generateTenantPin = async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Tenant PIN service is unavailable.',
      });
    }

    const lease = await findActiveLease(req.params.leaseId);

    if (!lease) {
      return res.status(404).json({
        error: 'An active lease was not found.',
      });
    }

    const unitNumber = getUnitNumber(lease);

    if (
      !Number.isInteger(unitNumber) ||
      unitNumber <= 0 ||
      String(unitNumber).length > 6
    ) {
      return res.status(400).json({
        error: 'This lease has an invalid unit number.',
      });
    }

    const pin = String(unitNumber);
    const pinHash = await argon2.hash(hashPinInput(pin), ARGON2_OPTIONS);

    const { error } = await supabase.rpc('reset_tenant_qr_pin', {
      p_lease_id: lease.id,
      p_pin_hash: pinHash,
    });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      unitNumber: getUnitNumber(lease),
      pin,
      message: 'Share this PIN privately. It will not be shown again.',
    });
  } catch (error) {
    console.error('Tenant PIN generation failed:', error?.message || error);
    return res.status(500).json({
      error: 'Unable to generate a tenant PIN.',
    });
  }
};

/**
 * Public QR PIN verification.
 * Only active leases can authenticate.
 */
export const verifyTenantPin = async (req, res) => {
  if (isIpRateLimited(req)) {
    return res.status(429).json({
      error: 'Too many attempts. Please try again later.',
    });
  }
  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Tenant verification is unavailable.',
      });
    }

    const unitNumber = Number(req.params.unitNumber);
    const pin = String(req.body?.pin ?? '');

    if (!Number.isInteger(unitNumber) || unitNumber <= 0) {
      return res.status(400).json({ error: 'Invalid unit number.' });
    }

    if (!/^\d{1,6}$/.test(pin)) {
      return res.status(401).json({
        error: 'Invalid PIN or unavailable tenant access.',
      });
    }

    const leases = await getLeases();
    const lease = leases.find(
      (item) =>
        getUnitNumber(item) === unitNumber &&
        isActiveLease(item)
    );

    if (!lease) {
      return res.status(401).json({
        error: 'Invalid PIN or unavailable tenant access.',
      });
    }

    const { data: access, error } = await supabase
      .from('tenant_qr_access')
      .select('*')
      .eq('lease_id', lease.id)
      .is('revoked_at', null)
      .maybeSingle();

    if (error) throw error;

    if (!access) {
      return res.status(401).json({
        error: 'Invalid PIN or unavailable tenant access.',
      });
    }

    if (
      access.locked_until &&
      new Date(access.locked_until).getTime() > Date.now()
    ) {
      return res.status(429).json({
        error: 'Too many attempts. Please try again later.',
      });
    }

    const matches = await argon2.verify(access.pin_hash, hashPinInput(pin));

    if (!matches) {
      const attempts = Number(access.failed_attempts || 0) + 1;
      const updates = {
        failed_attempts: attempts >= MAX_FAILED_ATTEMPTS ? 0 : attempts,
        locked_until:
          attempts >= MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_MS).toISOString()
            : null,
        updated_at: new Date().toISOString(),
      };

      const { error: updateError } = await supabase
        .from('tenant_qr_access')
        .update(updates)
        .eq('id', access.id);

      if (updateError) throw updateError;

      return res.status(401).json({
        error: 'Invalid PIN or unavailable tenant access.',
      });
    }

    const now = new Date();
    const rawToken = crypto.randomBytes(32).toString('base64url');

    const { error: resetError } = await supabase
      .from('tenant_qr_access')
      .update({
        failed_attempts: 0,
        locked_until: null,
        updated_at: now.toISOString(),
      })
      .eq('id', access.id);

    if (resetError) throw resetError;

    const { error: sessionError } = await supabase
      .from('tenant_qr_sessions')
      .insert({
        access_id: access.id,
        token_hash: hashToken(rawToken),
        created_at: now.toISOString(),
        last_activity_at: now.toISOString(),
        expires_at: new Date(
          now.getTime() + SESSION_LIFETIME_MS
        ).toISOString(),
      });

    if (sessionError) throw sessionError;

    return res.json({
      success: true,
      token: rawToken,
      unitNumber,
      expiresInSeconds: SESSION_LIFETIME_MS / 1000,
      idleTimeoutSeconds: IDLE_TIMEOUT_MS / 1000,
    });
  } catch (error) {
    console.error('Tenant PIN verification failed:', error?.message || error);
    return res.status(500).json({
      error: 'Unable to verify the PIN right now.',
    });
  }
};

/**
 * Protect a QR route using the server-side tenant session.
 * Mount after the existing multipart parser on the maintenance route.
 */
export const requireTenantQrSession = async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Tenant access service is unavailable.',
      });
    }

    const match = String(req.headers.authorization || '')
      .match(/^Bearer\s+(\S+)$/i);

    if (!match) {
      return res.status(401).json({
        error: 'Please verify your tenant PIN first.',
      });
    }

    const tokenHash = hashToken(match[1]);

    const { data: session, error: sessionError } = await supabase
      .from('tenant_qr_sessions')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (sessionError) throw sessionError;

    const now = Date.now();

    if (
      !session ||
      new Date(session.expires_at).getTime() <= now ||
      now - new Date(session.last_activity_at).getTime() > IDLE_TIMEOUT_MS
    ) {
      return res.status(401).json({
        error: 'Your tenant session has expired. Verify your PIN again.',
      });
    }

    const { data: access, error: accessError } = await supabase
      .from('tenant_qr_access')
      .select('*')
      .eq('id', session.access_id)
      .is('revoked_at', null)
      .maybeSingle();

    if (accessError) throw accessError;

    if (!access) {
      return res.status(401).json({
        error: 'Tenant access is no longer active.',
      });
    }

    const leases = await getLeases();
    const lease = leases.find(
      (item) =>
        String(item.id) === String(access.lease_id) &&
        isActiveLease(item)
    );

    if (
      !lease ||
      getUnitNumber(lease) !== Number(req.params.unitNumber)
    ) {
      return res.status(403).json({
        error: 'This session is not authorized for this unit.',
      });
    }

    const { error: activityError } = await supabase
      .from('tenant_qr_sessions')
      .update({ last_activity_at: new Date(now).toISOString() })
      .eq('id', session.id)
      .is('revoked_at', null);

    if (activityError) throw activityError;

    req.tenantQrAccess = {
      accessId: access.id,
      leaseId: lease.id,
      tenantId: lease.tenantId ?? lease.tenant_id ?? null,
      unitNumber: getUnitNumber(lease),
    };

    return next();
  } catch (error) {
    console.error('Tenant session validation failed:', error?.message || error);
    return res.status(500).json({
      error: 'Unable to validate the tenant session.',
    });
  }
};
