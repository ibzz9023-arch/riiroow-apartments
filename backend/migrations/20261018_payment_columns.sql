-- Add verification metadata required by payment notification review.
-- Safe to apply to existing databases: no historical payment rows are rewritten.

BEGIN;

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS verification_status TEXT,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_by TEXT;

COMMIT;
