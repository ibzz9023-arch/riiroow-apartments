-- Lease-specific scanned document archive and long-lived QR access.
-- Apply only after reviewing the live schema and receiving explicit approval.
-- The application uses the service-role client; browser roles receive no table
-- or Storage access. Public access is mediated by the server using a bearer token.

BEGIN;

CREATE TABLE IF NOT EXISTS public.lease_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  file_size bigint NOT NULL CHECK (file_size BETWEEN 1 AND 10485760),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_documents_lease_created
  ON public.lease_documents (lease_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lease_document_access (
  lease_id uuid PRIMARY KEY REFERENCES public.leases(id) ON DELETE RESTRICT,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_nonce text NOT NULL CHECK (token_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  revoked_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_document_access_token_hash
  ON public.lease_document_access (token_hash);

ALTER TABLE public.lease_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_document_access ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.lease_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.lease_document_access FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lease_documents TO service_role;
GRANT ALL ON TABLE public.lease_document_access TO service_role;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'lease-documents',
  'lease-documents',
  false,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;
