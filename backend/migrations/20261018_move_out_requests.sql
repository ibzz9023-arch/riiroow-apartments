-- Review-only migration for tenant QR move-out requests.
-- Do not run against production until explicitly approved.

CREATE TABLE IF NOT EXISTS public.move_out_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id text NOT NULL,
    tenant_id text NOT NULL,
    unit_id text NOT NULL,
    property_id text,
    unit_number integer NOT NULL,
    requested_move_out_date date NOT NULL,
    reason text,
    status text NOT NULL DEFAULT 'Pending Review'
        CHECK (status IN ('Pending Review', 'Approved', 'Rejected')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by text,
    review_note text,
    CONSTRAINT move_out_requests_reason_length
        CHECK (reason IS NULL OR char_length(reason) <= 1000),
    CONSTRAINT move_out_requests_review_note_length
        CHECK (review_note IS NULL OR char_length(review_note) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_status_submitted
    ON public.move_out_requests (status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_lease_submitted
    ON public.move_out_requests (lease_id, submitted_at DESC);

-- Access is provided by the backend service role only.
ALTER TABLE public.move_out_requests ENABLE ROW LEVEL SECURITY;

-- Prevent more than one pending request per lease, including concurrent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_move_out_requests_one_pending_per_lease
    ON public.move_out_requests (lease_id)
    WHERE status = 'Pending Review';
