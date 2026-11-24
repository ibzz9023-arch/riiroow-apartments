import { Router } from 'express';
import crypto from 'node:crypto';
import { supabaseServiceRole } from './supabaseClient.js';
import { requireRoles } from './authSession.js';
import { createSignedLeasePdf, decodeSignaturePng, hashLeaseSnapshot } from './leaseSigning.js';

export const leaseSigningRouter = Router();
const BUCKET = 'lease-documents';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const managerOnly = requireRoles('Admin', 'Manager');

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
    .select('id, name')
    .eq('id', lease.tenant_id)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant) throw Object.assign(new Error('The tenant assigned to this lease could not be found.'), { statusCode: 409 });
  const snapshot = {
    id: lease.id,
    tenant_id: lease.tenant_id,
    tenant_name: tenant.name,
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

const finalizeSession = async (session) => {
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
  const pdf = await createSignedLeasePdf({
    snapshot: session.lease_snapshot,
    tenantSignature,
    managerSignature,
    tenantSignedAt: session.tenant_signed_at,
    managerSignedAt: session.manager_signed_at,
    tenantName: session.tenant_name,
    managerName: session.manager_name,
    sessionId: session.id,
  });
  if (pdf.length > 10 * 1024 * 1024) {
    throw Object.assign(new Error('The generated signed lease exceeds the 10 MB document limit.'), { statusCode: 413 });
  }

  const storagePath = `${session.lease_id}/signed/${session.id}.pdf`;
  const { error: uploadError } = await bucket.upload(storagePath, pdf, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (uploadError) throw uploadError;

  let documentId = session.final_document_id || crypto.randomUUID();
  const documentHash = crypto.createHash('sha256').update(pdf).digest('hex');
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
        file_size: pdf.length,
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
  return sessionResponse(updated);
};

leaseSigningRouter.get('/:id/signing', managerOnly, async (req, res) => {
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
    return res.status(201).json({ session: sessionResponse(session) });
  } catch (error) {
    return sendError(res, error, 'Unable to start lease signing.');
  }
});

leaseSigningRouter.post('/:id/signing/:sessionId/signature', managerOnly, async (req, res) => {
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
    const signerType = String(req.body?.signerType || '');
    if (!['tenant', 'manager'].includes(signerType)) {
      return res.status(400).json({ error: 'Choose a valid signer.' });
    }
    if (signerType === 'tenant' && session.tenant_signed_at) {
      return res.status(409).json({ error: 'The tenant has already signed this lease.' });
    }
    if (signerType === 'manager' && !session.tenant_signed_at) {
      return res.status(409).json({ error: 'The tenant must sign before the manager.' });
    }
    if (signerType === 'manager' && session.manager_signed_at) {
      return res.json({ session: await finalizeSession(session) });
    }

    const signature = decodeSignaturePng(req.body?.signatureDataUrl);
    let signerName;
    let update;
    if (signerType === 'tenant') {
      signerName = current.tenant.name;
      update = {
        tenant_signature_path: `${req.params.id}/signatures/${session.id}-tenant.png`,
        tenant_signed_at: new Date().toISOString(),
        tenant_captured_by: req.auth.sub,
        status: 'awaiting_manager',
        updated_at: new Date().toISOString(),
      };
    } else {
      const { data: manager, error: managerError } = await supabaseServiceRole
        .from('users')
        .select('id, name')
        .eq('id', req.auth.sub)
        .maybeSingle();
      if (managerError) throw managerError;
      if (!manager) return res.status(403).json({ error: 'The manager account could not be verified.' });
      signerName = manager.name || 'Authorized Manager';
      update = {
        manager_signature_path: `${req.params.id}/signatures/${session.id}-manager.png`,
        manager_signed_at: new Date().toISOString(),
        manager_signed_by: req.auth.sub,
        manager_name: signerName,
        status: 'document_pending',
        updated_at: new Date().toISOString(),
      };
    }

    const storagePath = signerType === 'tenant' ? update.tenant_signature_path : update.manager_signature_path;
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
    if (signerType === 'manager') {
      try {
        return res.json({ session: await finalizeSession(updated) });
      } catch (finalizeError) {
        console.error('Signed lease PDF generation failed:', finalizeError?.message || finalizeError);
        return res.status(202).json({
          session: sessionResponse(updated),
          warning: 'Both signatures were saved. The final PDF could not be uploaded yet; retry document generation.',
        });
      }
    }
    return res.json({ session: sessionResponse(updated) });
  } catch (error) {
    return sendError(res, error, 'Unable to save the lease signature.');
  }
});

leaseSigningRouter.post('/:id/signing/:sessionId/finalize', managerOnly, async (req, res) => {
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Private lease document storage is not configured.' });
    const session = await getSession(req.params.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Signing session not found.' });
    return res.json({ session: await finalizeSession(session) });
  } catch (error) {
    return sendError(res, error, 'Unable to generate or upload the signed lease PDF.');
  }
});
