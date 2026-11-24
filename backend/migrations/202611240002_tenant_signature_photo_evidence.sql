-- Retain the tenant's original paper-signature photograph as private evidence.
-- The extracted PNG is used in the signed PDF; this source image is available
-- only to authenticated Admin/Manager users through a short-lived signed URL.
alter table public.lease_signing_sessions
  add column if not exists tenant_signature_source_path text;

comment on column public.lease_signing_sessions.tenant_signature_source_path is
  'Private Storage path to the original tenant paper-signature photo; retained for manager review and not exposed to tenant/public clients.';
