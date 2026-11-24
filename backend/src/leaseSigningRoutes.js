import { Router } from 'express';
import crypto from 'node:crypto';
import { supabaseServiceRole } from './supabaseClient.js';
import { getSessionSecret, requireRoles } from './authSession.js';
import QRCode from 'qrcode';
import {
  createLeaseDocumentNonce,
  deriveLeaseDocumentToken,
  hashLeaseDocumentToken,
  leaseDocumentTokenMatchesHash,
} from './leaseDocumentTokens.js';
import { createSignedLeasePdf, decodeSignaturePng, hashLeaseSnapshot } from './leaseSigning.js';
import { requireTenantQrSession } from './tenantQrAuth.js';

export const leaseSigningRouter = Router();
export const tenantLeaseSigningRouter = Router();
const BUCKET = 'lease-documents';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const managerOnly = requireRoles('Admin', 'Manager');
const getDocumentTokenSecret = () => {
  const configured = String(process.env.LEASE_DOCUMENT_TOKEN_SECRET || '').trim();
  if (!configured) return getSessionSecret();
  if (!/^[A-Za-z0-9_-]+$/.test(configured)) {
    throw new Error('LEASE_DOCUMENT_TOKEN_SECRET must be canonical base64url.');
  }
  const secret = Buffer.from(configured, 'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== configured) {
    throw new Error('LEASE_DOCUMENT_TOKEN_SECRET must contain at least 32 random bytes.');
  }
  return secret;
};

const getOrCreateDocumentToken = async (leaseId, createdBy) => {
  const secret = getDocumentTokenSecret();
  const { data: existing, error } = await supabaseServiceRole
    .from('lease_document_access')
    .select('token_hash, token_nonce, revoked_at')
    .eq('lease_id', leaseId)
    .maybeSingle();
  if (error) throw error;
  if (existing) {
    if (existing.revoked_at) {
      throw Object.assign(new Error('Lease QR access is revoked. A manager must regenerate the QR link before finalizing the signed PDF.'), { statusCode: 409 });
    }
    const token = deriveLeaseDocumentToken(leaseId, existing.token_nonce, secret);
    if (!leaseDocumentTokenMatchesHash(token, existing.token_hash)) {
      throw Object.assign(new Error('Lease QR token configuration does not match the existing link. Regenerate the QR link before signing.'), { statusCode: 409 });
    }
    return token;
  }

  const nonce = createLeaseDocumentNonce();
  const token = deriveLeaseDocumentToken(leaseId, nonce, secret);
  const now = new Date().toISOString();
  const { error: insertError } = await supabaseServiceRole.from('lease_document_access').insert([{
    lease_id: leaseId,
    token_hash: hashLeaseDocumentToken(token),
    token_nonce: nonce,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  }]);
  if (!insertError) return token;
  if (insertError.code === '23505') {
    const { data: raced, error: racedError } = await supabaseServiceRole
      .from('lease_document_access')
      .select('token_hash, token_nonce, revoked_at')
      .eq('lease_id', leaseId)
      .maybeSingle();
    if (racedError) throw racedError;
    if (raced && !raced.revoked_at) {
      const racedToken = deriveLeaseDocumentToken(leaseId, raced.token_nonce, secret);
      if (leaseDocumentTokenMatchesHash(racedToken, raced.token_hash)) return racedToken;
    }
  }
  throw insertError;
};


const sendError = (res, error, fallback) => {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) console.error(fallback, error?.message || error);
  return res.status(status).json({ error: status < 500 ? error.message : fallback });
};

const getLeaseAndTenant = async (leaseId) => {
  if (!UUID.test(String(leaseId || ''))) return null;
  const { data: lease, error } = await supabaseServiceRole
    .from('leases')
    .select('id, tenant_id, unit_id, unit_number, start_date, end_date, monthly_rent, security_deposit, status, notes')
    .eq('id', leaseId)
    .maybeSingle();
  if (error) throw error;
  if (!lease) return null;
  const { data: tenant, error: tenantError } = await supabaseServiceRole
    .from('tenants')
    .select('id, name, phone, email, photo_storage_path')
    .eq('id', lease.tenant_id)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant) throw Object.assign(new Error('The tenant assigned to this lease could not be found.'), { statusCode: 409 });
  const snapshot = {
    id: lease.id,
    tenant_id: lease.tenant_id,
    tenant_name: tenant.name,
    tenant_phone: tenant.phone || '',
    tenant_email: tenant.email || '',
    tenant_photo_storage_path: tenant.photo_storage_path || null,
    unit_id: lease.unit_id,
    unit_number: lease.unit_number,
    start_date: lease.start_date,
    end_date: lease.end_date,
    monthly_rent: Number(lease.monthly_rent || 0),
    security_deposit: Number(lease.security_deposit || 0),
    status: lease.status,
    notes: lease.notes || '',
  };
  return { lease, tenant, snapshot, leaseHash: hashLeaseSnapshot(snapshot) };
};

const getSession = async (leaseId, sessionId) => {
  const { data, error } = await supabaseServiceRole
    .from('lease_signing_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('lease_id', leaseId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const sessionResponse = (session) => ({
  id: session.id,
  status: session.status,
  tenantName: session.tenant_name,
  tenantSignedAt: session.tenant_signed_at,
  managerName: session.manager_name,
  managerSignedAt: session.manager_signed_at,
  documentReady: session.status === 'signed',
});

const recordSigningEvent = async ({ leaseId, sessionId, eventType, actorType, actorUserId = null, actorName = null, metadata = {} }) => {
  const { error } = await supabaseServiceRole.from('lease_signing_events').insert([{
    lease_id: leaseId,
    session_id: sessionId,
    event_type: eventType,
    actor_type: actorType,
    actor_user_id: actorUserId,
    actor_name: actorName,
    metadata,
  }]);
  if (error) {
    console.error('Lease signing audit event could not be recorded:', eventType, error.message || error);
  }
};

const finalizeSession = async (session, appOrigin) => {
  if (session.status === 'signed' && session.final_document_id) return sessionResponse(session);
  if (!session.tenant_signature_path || !session.manager_signature_path || !session.tenant_signed_at || !session.manager_signed_at) {
    throw Object.assign(new Error('Both signatures are required before the final lease can be generated.'), { statusCode: 409 });
  }

  const bucket = supabaseServiceRole.storage.from(BUCKET);
  const [{ data: tenantImage, error: tenantImageError }, { data: managerImage, error: managerImageError }] = await Promise.all([
    bucket.download(session.tenant_signature_path),
    bucket.download(session.manager_signature_path),
  ]);
  if (tenantImageError) throw tenantImageError;
  if (managerImageError) throw managerImageError;
  const [tenantSignature, managerSignature] = await Promise.all([
    tenantImage.arrayBuffer().then((bytes) => Buffer.from(bytes)),
    managerImage.arrayBuffer().then((bytes) => Buffer.from(bytes)),
  ]);
  let tenantPhoto = null;
  if (session.lease_snapshot.tenant_photo_storage_path) {
    try {
      const { data: photo, error: photoError } = await supabaseServiceRole.storage
        .from('tenant-photos')
        .download(session.lease_snapshot.tenant_photo_storage_path);
      if (!photoError && photo) {
        const photoBuffer = Buffer.from(await photo.arrayBuffer());
        const isJpeg = photoBuffer[0] === 0xff && photoBuffer[1] === 0xd8 && photoBuffer[2] === 0xff;
        const isPng = photoBuffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (isJpeg || isPng) tenantPhoto = photoBuffer;
      }
    } catch (photoError) {
      console.warn('Optional tenant photo could not be included in signed lease:', photoError?.message || photoError);
    }
  }
  const documentToken = await getOrCreateDocumentToken(session.lease_id, session.manager_signed_by);
  const publicDocumentUrl = `${String(appOrigin || '').replace(/\/$/, '')}/lease-documents/${documentToken}`;
  const qrBuffer = await QRCode.toBuffer(publicDocumentUrl, {
    type: 'png',
    width: 190,
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  const pdf = await createSignedLeasePdf({
    snapshot: session.lease_snapshot,
    tenantSignature,
    managerSignature,
    tenantSignedAt: session.tenant_signed_at,
    managerSignedAt: session.manager_signed_at,
    tenantName: session.tenant_name,
    managerName: session.manager_name,
    tenantPhoto,
    sessionId: session.id,
    qrBuffer,
  });
  if (pdf.length > 10 * 1024 * 1024) {
    throw Object.assign(new Error('The generated signed lease exceeds the 10 MB document limit.'), { statusCode: 413 });
  }

  const storagePath = `${session.lease_id}/signed/${session.id}.pdf`;
  const { error: uploadError } = await bucket.upload(storagePath, pdf, {
    contentType: 'application/pdf',
    upsert: false,
  });
  let finalPdf = pdf;
  if (uploadError) {
    // A prior attempt may have uploaded the immutable PDF before its database
    // record was committed. Reuse those exact bytes instead of overwriting them.
    const { data: existingPdf, error: existingPdfError } = await bucket.download(storagePath);
    if (existingPdfError || !existingPdf) throw uploadError;
    finalPdf = Buffer.from(await existingPdf.arrayBuffer());
  }

  let documentId = session.final_document_id || crypto.randomUUID();
  const documentHash = crypto.createHash('sha256').update(finalPdf).digest('hex');
  if (!session.final_document_id) {
    const { data: existingDocument, error: existingDocumentError } = await supabaseServiceRole
      .from('lease_documents')
      .select('id')
      .eq('lease_id', session.lease_id)
      .eq('storage_path', storagePath)
      .maybeSingle();
    if (existingDocumentError) throw existingDocumentError;
    if (existingDocument?.id) {
      documentId = existingDocument.id;
    } else {
      const { error: insertError } = await supabaseServiceRole.from('lease_documents').insert([{
        id: documentId,
        lease_id: session.lease_id,
        original_name: 'Signed_Lease_Agreement.pdf',
        storage_path: storagePath,
        mime_type: 'application/pdf',
        file_size: finalPdf.length,
        document_type: 'signed_lease',
        created_by: session.manager_signed_by,
      }]);
      if (insertError) throw insertError;
    }
  }
  const { data: updated, error: updateError } = await supabaseServiceRole
    .from('lease_signing_sessions')
    .update({
      status: 'signed',
      final_document_id: documentId,
      final_document_sha256: documentHash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id)
    .select('*')
    .single();
  if (updateError) throw updateError;
  await recordSigningEvent({
    leaseId: session.lease_id,
    sessionId: session.id,
    eventType: 'signed_pdf_generated',
    actorType: 'system',
    metadata: { documentId, sha256: documentHash, fileSize: finalPdf.length },
  });
  return sessionResponse(updated);
};


const getTenantSigningLease = async (req) => {
  const leaseId = req.tenantQrAccess?.leaseId;
  if (!leaseId) return null;
  const current = await getLeaseAndTenant(leaseId);
  if (!current) return null;
  const unitNumber = Number(current.lease.unit_number ?? current.lease.unitNumber);
  if (unitNumber !== Number(req.params.unitNumber)) return null;
  return current;
};

tenantLeaseSigningRouter.get('/:unitNumber/lease-signing', requireTenantQrSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const current = await getTenantSigningLease(req);
    if (!current) return res.status(404).json({ error: 'No lease is available for this tenant session.' });
    const { data: session, error } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .select('*')
      .eq('lease_id', current.lease.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({
      lease: {
        id: current.lease.id,
        tenantName: current.tenant.name,
        unitNumber: current.lease.unit_number ?? current.lease.unitNumber,
        startDate: current.lease.start_date,
        endDate: current.lease.end_date,
        monthlyRent: current.lease.monthly_rent,
        securityDeposit: current.lease.security_deposit,
        notes: current.lease.notes || '',
      },
      session: session ? sessionResponse(session) : null,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load the tenant lease for signing.');
  }
});

tenantLeaseSigningRouter.post('/:unitNumber/lease-signing/:sessionId/signature', requireTenantQrSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const current = await getTenantSigningLease(req);
    if (!current) return res.status(404).json({ error: 'No lease is available for this tenant session.' });
    const session = await getSession(current.lease.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Signing session not found.' });
    if (session.status !== 'awaiting_tenant' || session.tenant_signed_at) {
      return res.status(409).json({ error: 'This lease is not awaiting a tenant signature.' });
    }
    if (req.body?.signerType !== 'tenant' || req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'The tenant must confirm their own handwritten signature.' });
    }
    if (current.leaseHash !== session.lease_hash) {
      return res.status(409).json({ error: 'Lease details changed. Ask management to prepare a new signing version.' });
    }
    const signature = decodeSignaturePng(req.body?.signatureDataUrl);
    const storagePath = `${current.lease.id}/signatures/${session.id}-tenant.png`;
    const { error: uploadError } = await supabaseServiceRole.storage.from(BUCKET).upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: false,
    });
    if (uploadError) throw uploadError;
    const signedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .update({
        tenant_signature_path: storagePath,
        tenant_signed_at: signedAt,
        tenant_captured_by: null,
        status: 'awaiting_manager',
        updated_at: signedAt,
      })
      .eq('id', session.id)
      .eq('status', 'awaiting_tenant')
      .is('tenant_signed_at', null)
      .select('*')
      .maybeSingle();
    if (updateError) {
      await supabaseServiceRole.storage.from(BUCKET).remove([storagePath]);
      throw updateError;
    }
    if (!updated) {
      await supabaseServiceRole.storage.from(BUCKET).remove([storagePath]);
      return res.status(409).json({ error: 'The tenant signature was already submitted.' });
    }
    await recordSigningEvent({
      leaseId: current.lease.id,
      sessionId: session.id,
      eventType: 'tenant_signed',
      actorType: 'tenant',
      actorName: current.tenant.name,
      metadata: { signatureSha256: crypto.createHash('sha256').update(signature).digest('hex') },
    });
    return res.json({ session: sessionResponse(updated) });
  } catch (error) {
    return sendError(res, error, 'Unable to save the tenant signature.');
  }
});

leaseSigningRouter.get('/:id/signing', managerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Private lease document storage is not configured.' });
    const { data, error } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .select('*')
      .eq('lease_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({ session: data ? sessionResponse(data) : null });
  } catch (error) {
    return sendError(res, error, 'Unable to load lease signing status.');
  }
});

leaseSigningRouter.post('/:id/signing/start', managerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Private lease document storage is not configured.' });
    const current = await getLeaseAndTenant(req.params.id);
    if (!current) return res.status(404).json({ error: 'Lease not found.' });
    const { data: existing, error: existingError } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .select('*')
      .eq('lease_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.lease_hash === current.leaseHash) {
      return res.json({ session: sessionResponse(existing) });
    }
    const { data: session, error } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .insert([{
        lease_id: req.params.id,
        lease_snapshot: current.snapshot,
        lease_hash: current.leaseHash,
        tenant_name: current.tenant.name,
        status: 'awaiting_tenant',
        created_by: req.auth.sub,
      }])
      .select('*')
      .single();
    if (error) throw error;
    await recordSigningEvent({
      leaseId: req.params.id,
      sessionId: session.id,
      eventType: existing ? 'lease_terms_changed' : 'session_created',
      actorType: 'manager',
      actorUserId: req.auth.sub,
      metadata: { leaseHash: current.leaseHash },
    });
    return res.status(201).json({ session: sessionResponse(session) });
  } catch (error) {
    return sendError(res, error, 'Unable to start lease signing.');
  }
});

leaseSigningRouter.post('/:id/signing/:sessionId/signature', managerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Private lease document storage is not configured.' });
    const session = await getSession(req.params.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Signing session not found.' });
    if (session.status === 'signed') return res.json({ session: sessionResponse(session) });
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'The signer must confirm that they have reviewed and agreed to sign this lease.' });
    }
    const current = await getLeaseAndTenant(req.params.id);
    if (!current || current.leaseHash !== session.lease_hash) {
      return res.status(409).json({ error: 'Lease details changed after signing began. Start a new signing session so both parties sign the same lease version.' });
    }
    if (String(req.body?.signerType || '') !== 'manager') {
      return res.status(403).json({ error: 'Tenant signatures must be submitted from the tenant PIN-verified QR session.' });
    }
    if (!session.tenant_signed_at) {
      return res.status(409).json({ error: 'The tenant must sign before the manager.' });
    }
    if (session.manager_signed_at) {
      return res.json({ session: await finalizeSession(session, process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`) });
    }

    const signature = decodeSignaturePng(req.body?.signatureDataUrl);
    const { data: manager, error: managerError } = await supabaseServiceRole
      .from('users')
      .select('id, name')
      .eq('id', req.auth.sub)
      .maybeSingle();
    if (managerError) throw managerError;
    if (!manager) return res.status(403).json({ error: 'The manager account could not be verified.' });
    const signerName = manager.name || 'Authorized Manager';
    const signedAt = new Date().toISOString();
    const storagePath = `${req.params.id}/signatures/${session.id}-manager.png`;
    const update = {
      manager_signature_path: storagePath,
      manager_signed_at: signedAt,
      manager_signed_by: req.auth.sub,
      manager_name: signerName,
      status: 'document_pending',
      updated_at: signedAt,
    };
    const { error: uploadError } = await supabaseServiceRole.storage.from(BUCKET).upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: false,
    });
    if (uploadError) throw uploadError;
    const { data: updated, error: updateError } = await supabaseServiceRole
      .from('lease_signing_sessions')
      .update(update)
      .eq('id', session.id)
      .select('*')
      .single();
    if (updateError) {
      await supabaseServiceRole.storage.from(BUCKET).remove([storagePath]);
      throw updateError;
    }
    await recordSigningEvent({
      leaseId: req.params.id,
      sessionId: session.id,
      eventType: 'manager_signed',
      actorType: 'manager',
      actorUserId: req.auth.sub,
      actorName: signerName,
      metadata: { signatureSha256: crypto.createHash('sha256').update(signature).digest('hex') },
    });
    try {
      return res.json({ session: await finalizeSession(updated, process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`) });
    } catch (finalizeError) {
      console.error('Signed lease PDF generation failed:', finalizeError?.message || finalizeError);
      await recordSigningEvent({
        leaseId: req.params.id,
        sessionId: updated.id,
        eventType: 'signed_pdf_generation_failed',
        actorType: 'system',
        metadata: { reason: String(finalizeError?.message || 'Unknown PDF generation error').slice(0, 300) },
      });
      return res.status(202).json({
        session: sessionResponse(updated),
        warning: 'Both signatures were saved. The final PDF could not be uploaded yet; retry document generation.',
      });
    }
  } catch (error) {
    return sendError(res, error, 'Unable to save the lease signature.');
  }
});

leaseSigningRouter.post('/:id/signing/:sessionId/finalize', managerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Private lease document storage is not configured.' });
    const session = await getSession(req.params.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Signing session not found.' });
    return res.json({ session: await finalizeSession(session, process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`) });
  } catch (error) {
    return sendError(res, error, 'Unable to generate or upload the signed lease PDF.');
  }
});
