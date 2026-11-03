-- Add retry protection without changing or deleting existing notifications.
-- Existing rows retain a NULL idempotency_key; new retries use a key unique
-- within the lease, while later submissions use a new key.

ALTER TABLE public.payment_notifications
    ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS payment_notifications_lease_idempotency_key_uq
    ON public.payment_notifications (lease_id, idempotency_key);