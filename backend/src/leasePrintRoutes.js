import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { supabaseServiceRole } from './supabaseClient.js';
import { getSessionSecret, requireRoles } from './authSession.js';
import {
  createLeaseDocumentNonce,
  deriveLeaseDocumentToken,
  hashLeaseDocumentToken,
  leaseDocumentTokenMatchesHash,
} from './leaseDocumentTokens.js';
import { createLeasePdf } from './leasePdfTemplate.js';

export const leasePrintRouter = Router();
const managerOnly = requireRoles('Admin', 'Manager');
const BUCKET = 'lease-documents';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const here = path.dirname(fileURLToPath(import.meta.url));

const getDocumentToken = async (leaseId, createdBy) => {
  const configured = String(process.env.LEASE_DOCUMENT_TOKEN_SECRET || '').trim();
  const secret = configured ? Buffer.from(configured, 'base64url') : getSessionSecret();
  if (configured && (secret.length < 32 || secret.toString('base64url') !== configured || !/^[A-Za-z0-9_-]+$/.test(configured))) {
    throw Object.assign(new Error('Lease document token configuration is invalid.'), { statusCode: 503 });
  }
  const { data: existing, error } = await supabaseServiceRole
    .from('lease_document_access')
    .select('token_hash, token_nonce, revoked_at')
    .eq('lease_id', leaseId)
    .maybeSingle();
  if (error) throw error;
  if (existing) {
    if (existing.revoked_at) throw Object.assign(new Error('Lease QR access is revoked. Regenerate the QR link before printing.'), { statusCode: 409 });
    const token = deriveLeaseDocumentToken(leaseId, existing.token_nonce, secret);
    if (!leaseDocumentTokenMatchesHash(token, existing.token_hash)) {
      throw Object.assign(new Error('Lease QR token configuration does not match the existing link.'), { statusCode: 409 });
    }
    return token;
  }
  const nonce = createLeaseDocumentNonce();
  const token = deriveLeaseDocumentToken(leaseId, nonce, secret);
  const { error: insertError } = await supabaseServiceRole.from('lease_document_access').insert([{
    lease_id: leaseId,
    token_hash: hashLeaseDocumentToken(token),
    token_nonce: nonce,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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

const loadOptionalImage = async (bucket, storagePath) => {
  if (!storagePath) return null;
  try {
    const { data, error } = await supabaseServiceRole.storage.from(bucket).download(storagePath);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
};

leasePrintRouter.get('/:id/print', managerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!supabaseServiceRole) return res.status(503).json({ error: 'Lease printing requires the configured private database and document storage.' });
    if (!UUID.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid lease reference.' });
    const { data: lease, error: leaseError } = await supabaseServiceRole
      .from('leases')
      .select('id, tenant_id, unit_id, unit_number, start_date, end_date, monthly_rent, security_deposit, status, notes')
      .eq('id', req.params.id)
      .maybeSingle();
    if (leaseError) throw leaseError;
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    const { data: tenant, error: tenantError } = await supabaseServiceRole
      .from('tenants')
      .select('id, name, phone, email, photo_storage_path')
      .eq('id', lease.tenant_id)
      .maybeSingle();
    if (tenantError) throw tenantError;
    if (!tenant) return res.status(409).json({ error: 'The tenant assigned to this lease could not be found.' });

    const snapshot = {
      id: lease.id,
      tenant_id: lease.tenant_id,
      tenant_name: tenant.name,
      tenant_phone: tenant.phone || '',
      tenant_email: tenant.email || '',
      unit_id: lease.unit_id,
      unit_number: lease.unit_number,
      start_date: lease.start_date,
      end_date: lease.end_date,
      monthly_rent: Number(lease.monthly_rent || 0),
      security_deposit: Number(lease.security_deposit || 0),
      status: lease.status,
      notes: lease.notes || '',
    };
    const [tenantPhoto, logoBuffer] = await Promise.all([
      loadOptionalImage('tenant-photos', tenant.photo_storage_path),
      readFile(path.resolve(here, '../../frontend/public/riiroow-logo.png')).catch(() => null),
    ]);
    const token = await getDocumentToken(lease.id, req.auth.sub);
    const appOrigin = String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const qrBuffer = await QRCode.toBuffer(`${appOrigin}/lease-documents/${token}`, {
      type: 'png', width: 220, margin: 2, errorCorrectionLevel: 'M',
    });
    const pdf = await createLeasePdf({ snapshot, tenantPhoto, qrBuffer, logoBuffer });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Riiroow-Lease-${lease.unit_number || lease.id}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    return res.send(pdf);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('Lease print PDF generation failed:', error?.message || error);
    return res.status(status).json({ error: status < 500 ? error.message : 'Unable to generate the lease PDF.' });
  }
});
