-- Riiroow Apartments: Security deposit accounting
-- REVIEW ONLY: Do not execute against production until approved.
-- Rent payments remain separate from security deposit transactions.

BEGIN;

-- Each lease has its own agreed security deposit amount.
ALTER TABLE public.leases
    ADD COLUMN IF NOT EXISTS security_deposit NUMERIC(12,2)
    NOT NULL DEFAULT 0;

-- Reject negative agreed deposit amounts.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.leases'::regclass
          AND conname = 'leases_security_deposit_nonnegative'
    ) THEN
        ALTER TABLE public.leases
            ADD CONSTRAINT leases_security_deposit_nonnegative
            CHECK (security_deposit >= 0);
    END IF;
END
$$;

-- Deposit transactions are independent of rent payments.
-- Supported types:
-- payment: deposit money received from a tenant
-- deduction: amount retained from the deposit at move-out
-- refund: deposit money returned to the tenant
CREATE TABLE IF NOT EXISTS public.security_deposit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    lease_id UUID NOT NULL
        REFERENCES public.leases(id) ON DELETE RESTRICT,

    transaction_type TEXT NOT NULL
        CHECK (transaction_type IN ('payment', 'deduction', 'refund')),

    amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    notes TEXT NOT NULL DEFAULT '',

    recorded_by TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
    idx_security_deposit_transactions_lease_date
ON public.security_deposit_transactions
    (lease_id, transaction_date, created_at);

-- Restrict direct table access; backend service_role uses the API.
ALTER TABLE public.security_deposit_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.security_deposit_transactions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.security_deposit_transactions TO service_role;

-- Atomically validate and record a security deposit transaction.
-- This function is installed only when the migration is explicitly applied.
CREATE OR REPLACE FUNCTION public.record_security_deposit_transaction(
    p_lease_id UUID,
    p_transaction_type TEXT,
    p_amount NUMERIC,
    p_transaction_date TIMESTAMPTZ DEFAULT NOW(),
    p_notes TEXT DEFAULT '',
    p_recorded_by TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_lease public.leases%ROWTYPE;
    v_received NUMERIC(12,2);
    v_used NUMERIC(12,2);
    v_transaction public.security_deposit_transactions%ROWTYPE;
BEGIN
    IF p_transaction_type IS NULL OR p_transaction_type NOT IN ('payment', 'deduction', 'refund') THEN
        RAISE EXCEPTION 'Invalid security deposit transaction type.'
            USING ERRCODE = '22023';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000000000 OR p_amount <> ROUND(p_amount, 2) THEN
        RAISE EXCEPTION 'Transaction amount must be positive and valid.'
            USING ERRCODE = '22023';
    END IF;

    IF p_transaction_date IS NULL THEN
        RAISE EXCEPTION 'Transaction date is required.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_lease
      FROM public.leases
     WHERE id = p_lease_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT
        COALESCE(
            SUM(amount) FILTER (WHERE transaction_type = 'payment'),
            0
        ),
        COALESCE(
            SUM(amount) FILTER (
                WHERE transaction_type IN ('deduction', 'refund')
            ),
            0
        )
      INTO v_received, v_used
      FROM public.security_deposit_transactions
     WHERE lease_id = p_lease_id;

    IF p_transaction_type = 'payment'
       AND v_received + p_amount > COALESCE(v_lease.security_deposit, 0) THEN
        RAISE EXCEPTION 'Payment exceeds the remaining agreed deposit.'
            USING ERRCODE = '22023';
    END IF;

    IF p_transaction_type IN ('deduction', 'refund')
       AND p_amount > v_received - v_used THEN
        RAISE EXCEPTION 'Transaction exceeds the available deposit.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.security_deposit_transactions (
        lease_id,
        transaction_type,
        amount,
        transaction_date,
        notes,
        recorded_by
    )
    VALUES (
        p_lease_id,
        p_transaction_type,
        p_amount,
        p_transaction_date,
        COALESCE(p_notes, ''),
        p_recorded_by
    )
    RETURNING * INTO v_transaction;

    RETURN TO_JSONB(v_transaction);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_security_deposit_transaction(
    UUID, TEXT, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.record_security_deposit_transaction(
    UUID, TEXT, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMIT;
