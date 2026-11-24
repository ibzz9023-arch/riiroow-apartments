-- Smart Lease Signing: independently timestamped tenant and manager signatures.
-- Signed PDFs are registered in the existing lease_documents archive.
BEGIN;

ALTER TABLE public.lease_documents
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lease_documents_document_type_check'
      AND conrelid = 'public.lease_documents'::regclass
  ) THEN
    ALTER TABLE public.lease_documents
      ADD CONSTRAINT lease_documents_document_type_check
      CHECK (document_type IN ('manual', 'signed_lease'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.lease_signing_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  lease_snapshot jsonb NOT NULL,
  lease_hash text NOT NULL CHECK (lease_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'awaiting_tenant'
    CHECK (status IN ('awaiting_tenant', 'awaiting_manager', 'document_pending', 'signed')),
  tenant_name text NOT NULL,
  tenant_signed_at timestamptz,
  tenant_signature_path text,
  tenant_captured_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  manager_name text,
  manager_signed_at timestamptz,
  manager_signature_path text,
  manager_signed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  final_document_id uuid REFERENCES public.lease_documents(id) ON DELETE SET NULL,
  final_document_sha256 text CHECK (final_document_sha256 IS NULL OR final_document_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_signing_sessions_lease_created
  ON public.lease_signing_sessions (lease_id, created_at DESC);

ALTER TABLE public.lease_signing_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lease_signing_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lease_signing_sessions TO service_role;

COMMIT;
