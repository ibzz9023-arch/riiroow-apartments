-- Manager-to-Admin approval requests.
-- Access is restricted to the backend service role; no client-side table policies are added.
CREATE TABLE IF NOT EXISTS public.approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_type TEXT NOT NULL CHECK (
        request_type IN (
            'rent_change',
            'security_deposit_refund',
            'lease_termination',
            'exceptional_expense',
            'tenant_deletion'
        )
    ),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 2000),
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'rejected')
    ),
    requester_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reviewer_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
    review_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (reviewer_id IS NULL OR reviewer_id <> requester_id),
    CHECK (
        (status = 'pending' AND reviewer_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
        OR (status = 'approved' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL)
        OR (status = 'rejected' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND review_reason IS NOT NULL AND char_length(trim(review_reason)) >= 3)
    )
);

CREATE INDEX IF NOT EXISTS approval_requests_status_submitted_idx
    ON public.approval_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_requester_submitted_idx
    ON public.approval_requests (requester_id, submitted_at DESC);

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
