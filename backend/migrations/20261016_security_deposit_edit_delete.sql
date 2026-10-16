BEGIN;

-- Safely edit a deposit transaction while preserving balance rules.
CREATE OR REPLACE FUNCTION public.update_security_deposit_transaction(
    p_lease_id UUID,
    p_transaction_id UUID,
    p_transaction_type TEXT,
    p_amount NUMERIC,
    p_transaction_date TIMESTAMPTZ,
    p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_lease public.leases%ROWTYPE;
    v_transaction public.security_deposit_transactions%ROWTYPE;
    v_received NUMERIC(12,2);
    v_used NUMERIC(12,2);
    v_new_received NUMERIC(12,2);
    v_new_used NUMERIC(12,2);
BEGIN
    IF p_transaction_type IS NULL
       OR p_transaction_type NOT IN ('payment', 'deduction', 'refund') THEN
        RAISE EXCEPTION 'Invalid security deposit transaction type.'
            USING ERRCODE = '22023';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0
       OR p_amount > 1000000000
       OR p_amount <> ROUND(p_amount, 2) THEN
        RAISE EXCEPTION 'Transaction amount must be positive and valid.'
            USING ERRCODE = '22023';
    END IF;

    IF p_transaction_date IS NULL THEN
        RAISE EXCEPTION 'Transaction date is required.'
            USING ERRCODE = '22023';
    END IF;

    IF LENGTH(COALESCE(p_notes, '')) > 1000 THEN
        RAISE EXCEPTION 'Notes cannot exceed 1000 characters.'
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

    SELECT *
      INTO v_transaction
      FROM public.security_deposit_transactions
     WHERE id = p_transaction_id
       AND lease_id = p_lease_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Security deposit transaction not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT
        COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'payment'
        ), 0),
        COALESCE(SUM(amount) FILTER (
            WHERE transaction_type IN ('deduction', 'refund')
        ), 0)
      INTO v_received, v_used
      FROM public.security_deposit_transactions
     WHERE lease_id = p_lease_id
       AND id <> p_transaction_id;

    v_new_received := v_received
        + CASE WHEN p_transaction_type = 'payment' THEN p_amount ELSE 0 END;

    v_new_used := v_used
        + CASE WHEN p_transaction_type IN ('deduction', 'refund')
               THEN p_amount ELSE 0 END;

    IF v_new_received > COALESCE(v_lease.security_deposit, 0) THEN
        RAISE EXCEPTION 'Payment exceeds the agreed security deposit.'
            USING ERRCODE = '22023';
    END IF;

    IF v_new_used > v_new_received THEN
        RAISE EXCEPTION 'Deductions and refunds exceed the received deposit.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.security_deposit_transactions
       SET transaction_type = p_transaction_type,
           amount = p_amount,
           transaction_date = p_transaction_date,
           notes = COALESCE(p_notes, '')
     WHERE id = p_transaction_id
       AND lease_id = p_lease_id
    RETURNING * INTO v_transaction;

    RETURN TO_JSONB(v_transaction);
END;
$function$;

-- Delete only when the remaining transactions still balance.
CREATE OR REPLACE FUNCTION public.delete_security_deposit_transaction(
    p_lease_id UUID,
    p_transaction_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_lease public.leases%ROWTYPE;
    v_transaction public.security_deposit_transactions%ROWTYPE;
    v_received NUMERIC(12,2);
    v_used NUMERIC(12,2);
BEGIN
    SELECT *
      INTO v_lease
      FROM public.leases
     WHERE id = p_lease_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT *
      INTO v_transaction
      FROM public.security_deposit_transactions
     WHERE id = p_transaction_id
       AND lease_id = p_lease_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Security deposit transaction not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT
        COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'payment'
        ), 0),
        COALESCE(SUM(amount) FILTER (
            WHERE transaction_type IN ('deduction', 'refund')
        ), 0)
      INTO v_received, v_used
      FROM public.security_deposit_transactions
     WHERE lease_id = p_lease_id
       AND id <> p_transaction_id;

    IF v_used > v_received THEN
        RAISE EXCEPTION 'Cannot delete this transaction because remaining deductions and refunds exceed the received deposit.'
            USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.security_deposit_transactions
     WHERE id = p_transaction_id
       AND lease_id = p_lease_id;

    RETURN TO_JSONB(v_transaction);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_security_deposit_transaction(
    UUID, UUID, TEXT, NUMERIC, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.delete_security_deposit_transaction(
    UUID, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_security_deposit_transaction(
    UUID, UUID, TEXT, NUMERIC, TIMESTAMPTZ, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.delete_security_deposit_transaction(
    UUID, UUID
) TO service_role;

COMMIT;
