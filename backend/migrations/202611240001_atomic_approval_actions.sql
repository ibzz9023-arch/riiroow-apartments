-- Atomically execute Admin approval decisions and their business operations.
-- Apply this migration before deploying the matching backend release.
BEGIN;

CREATE OR REPLACE FUNCTION public.review_approval_request(
    p_request_id UUID,
    p_action TEXT,
    p_reviewer_id UUID,
    p_review_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_request public.approval_requests%ROWTYPE;
    v_details JSONB;
    v_target TEXT;
    v_target_id UUID;
    v_current_rent NUMERIC(12,2);
    v_requested_rent NUMERIC(12,2);
    v_amount NUMERIC(12,2);
    v_status TEXT;
    v_rows INTEGER;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
    v_expense_result JSONB;
BEGIN
    IF p_action IS NULL OR p_action NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'Choose approve or reject.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.users
         WHERE id = p_reviewer_id
           AND is_active = TRUE
           AND role = 'Admin'
    ) THEN
        RAISE EXCEPTION 'An active Admin account is required to review requests.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_request
      FROM public.approval_requests
     WHERE id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Approval request not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_request.requester_id = p_reviewer_id THEN
        RAISE EXCEPTION 'You cannot approve or reject your own request.'
            USING ERRCODE = '42501';
    END IF;

    IF v_request.status <> 'pending' THEN
        RAISE EXCEPTION 'This request has already been reviewed.'
            USING ERRCODE = '23505';
    END IF;

    IF p_action = 'reject' THEN
        IF p_review_reason IS NULL
           OR LENGTH(BTRIM(p_review_reason)) < 3
           OR LENGTH(BTRIM(p_review_reason)) > 2000 THEN
            RAISE EXCEPTION 'A written rejection reason between 3 and 2,000 characters is required.'
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.approval_requests
           SET status = 'rejected',
               reviewer_id = p_reviewer_id,
               review_reason = BTRIM(p_review_reason),
               reviewed_at = NOW(),
               updated_at = NOW()
         WHERE id = p_request_id
        RETURNING * INTO v_request;

        RETURN TO_JSONB(v_request);
    END IF;

    v_details := COALESCE(v_request.details, '{}'::jsonb);

    CASE v_request.request_type
      WHEN 'lease_termination' THEN
        v_target_id := NULLIF(BTRIM(v_details->>'leaseId'), '')::uuid;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'This lease-termination request is missing its lease ID.'
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.leases
           SET status = 'Terminated',
               notes = CASE
                 WHEN POSITION('Approved lease termination request ' || p_request_id::text IN COALESCE(notes, '')) > 0
                   THEN COALESCE(notes, '')
                 ELSE CONCAT_WS(' ', NULLIF(BTRIM(COALESCE(notes, '')), ''),
                     'Approved lease termination request ' || p_request_id::text || ': ' || BTRIM(v_request.reason))
               END
         WHERE id = v_target_id
           AND LOWER(COALESCE(status, '')) <> 'terminated';

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 AND NOT EXISTS (
            SELECT 1 FROM public.leases
             WHERE id = v_target_id AND LOWER(COALESCE(status, '')) = 'terminated'
        ) THEN
            RAISE EXCEPTION 'The requested lease was not found.'
                USING ERRCODE = 'P0002';
        END IF;

      WHEN 'rent_change' THEN
        v_target := LOWER(BTRIM(COALESCE(v_details->>'target', '')));
        v_current_rent := NULLIF(BTRIM(v_details->>'currentRent'), '')::numeric;
        v_requested_rent := NULLIF(BTRIM(v_details->>'requestedRent'), '')::numeric;

        IF v_current_rent IS NULL OR v_requested_rent IS NULL
           OR v_current_rent < 0 OR v_requested_rent <= 0
           OR v_requested_rent > 1000000000
           OR v_requested_rent <> ROUND(v_requested_rent, 2) THEN
            RAISE EXCEPTION 'The rent-change request must include valid currentRent and requestedRent amounts.'
                USING ERRCODE = '22023';
        END IF;

        IF v_target = 'unit' THEN
            v_target_id := NULLIF(BTRIM(v_details->>'unitId'), '')::uuid;
            IF v_target_id IS NULL THEN
                RAISE EXCEPTION 'The rent-change request is missing its unit ID.'
                    USING ERRCODE = '22023';
            END IF;
            UPDATE public.units
               SET rent = v_requested_rent
             WHERE id = v_target_id
               AND rent = v_current_rent;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows = 0 AND NOT EXISTS (
                SELECT 1 FROM public.units
                 WHERE id = v_target_id AND rent = v_requested_rent
            ) THEN
                RAISE EXCEPTION 'The unit rent changed after this request was submitted. Refresh and submit a new request.'
                    USING ERRCODE = '40001';
            END IF;
        ELSIF v_target = 'lease' THEN
            v_target_id := NULLIF(BTRIM(v_details->>'leaseId'), '')::uuid;
            IF v_target_id IS NULL THEN
                RAISE EXCEPTION 'The rent-change request is missing its lease ID.'
                    USING ERRCODE = '22023';
            END IF;
            UPDATE public.leases
               SET monthly_rent = v_requested_rent
             WHERE id = v_target_id
               AND monthly_rent = v_current_rent
               AND LOWER(COALESCE(status, '')) = 'active';
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows = 0 AND NOT EXISTS (
                SELECT 1 FROM public.leases
                 WHERE id = v_target_id
                   AND monthly_rent = v_requested_rent
                   AND LOWER(COALESCE(status, '')) = 'active'
            ) THEN
                RAISE EXCEPTION 'The lease rent changed or the lease is no longer active. Refresh and submit a new request.'
                    USING ERRCODE = '40001';
            END IF;
        ELSE
            RAISE EXCEPTION 'The rent-change request target must be unit or lease.'
                USING ERRCODE = '22023';
        END IF;

      WHEN 'security_deposit_refund' THEN
        v_target_id := NULLIF(BTRIM(v_details->>'leaseId'), '')::uuid;
        v_amount := NULLIF(BTRIM(v_details->>'amount'), '')::numeric;
        IF v_target_id IS NULL OR v_amount IS NULL
           OR v_amount <= 0 OR v_amount > 1000000000
           OR v_amount <> ROUND(v_amount, 2) THEN
            RAISE EXCEPTION 'The security-deposit refund request is missing a valid lease ID or amount.'
                USING ERRCODE = '22023';
        END IF;

        PERFORM public.record_security_deposit_transaction(
            v_target_id,
            'refund',
            v_amount,
            COALESCE(NULLIF(v_details->>'transactionDate', '')::timestamptz, NOW()),
            LEFT(
                CONCAT_WS(' | ',
                    NULLIF(BTRIM(COALESCE(v_details->>'notes', '')), ''),
                    'Approved request ' || p_request_id::text || ': ' || BTRIM(v_request.reason)
                ),
                1000
            ),
            p_reviewer_id::text
        );

      WHEN 'exceptional_expense' THEN
        v_status := LOWER(COALESCE(NULLIF(BTRIM(v_details->>'status'), ''), 'paid'));
        IF v_status NOT IN ('paid', 'unpaid') THEN
            RAISE EXCEPTION 'Exceptional expense status must be paid or unpaid.'
                USING ERRCODE = '22023';
        END IF;

        v_expense_result := public.create_financial_expense(
            NULLIF(COALESCE(v_details->>'propertyId', v_details->>'property_id'), '')::uuid,
            NULLIF(COALESCE(v_details->>'categoryId', v_details->>'category_id'), '')::uuid,
            NULLIF(BTRIM(v_details->>'amount'), '')::numeric,
            COALESCE(NULLIF(BTRIM(v_details->>'description'), ''), BTRIM(v_request.title)),
            NULLIF(COALESCE(v_details->>'expenseOn', v_details->>'expense_on'), '')::date,
            CASE WHEN v_status = 'unpaid' THEN NULL
                 ELSE NULLIF(COALESCE(v_details->>'paidOn', v_details->>'paid_on'), '')::date
            END,
            NULLIF(COALESCE(v_details->>'paymentMethod', v_details->>'payment_method'), ''),
            NULLIF(COALESCE(v_details->>'transactionReference', v_details->>'transaction_reference'), ''),
            NULL,
            p_request_id,
            p_reviewer_id,
            v_status
        );

      WHEN 'tenant_deletion' THEN
        v_target_id := NULLIF(BTRIM(v_details->>'tenantId'), '')::uuid;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'The tenant-deletion request is missing its tenant ID.'
                USING ERRCODE = '22023';
        END IF;

        IF EXISTS (SELECT 1 FROM public.leases WHERE tenant_id = v_target_id)
           OR EXISTS (SELECT 1 FROM public.payments WHERE tenant_id = v_target_id)
           OR EXISTS (SELECT 1 FROM public.maintenance_requests WHERE tenant_id = v_target_id)
           OR EXISTS (SELECT 1 FROM public.rent_legacy_balances WHERE tenant_id = v_target_id)
           OR EXISTS (SELECT 1 FROM public.rent_receipts WHERE tenant_id = v_target_id)
           OR EXISTS (SELECT 1 FROM public.tenant_credit_accounts WHERE tenant_id = v_target_id) THEN
            RAISE EXCEPTION 'Tenants with historical lease, payment, maintenance, receipt, or credit records cannot be deleted. Terminate the lease instead to preserve records.'
                USING ERRCODE = '23503';
        END IF;

        DELETE FROM public.tenants WHERE id = v_target_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'The requested tenant was not found.'
                USING ERRCODE = 'P0002';
        END IF;

      ELSE
        RAISE EXCEPTION 'Unsupported approval request type.'
            USING ERRCODE = '22023';
    END CASE;

    UPDATE public.approval_requests
       SET status = 'approved',
           reviewer_id = p_reviewer_id,
           review_reason = NULLIF(BTRIM(COALESCE(p_review_reason, '')), ''),
           reviewed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_request_id
    RETURNING * INTO v_request;

    RETURN TO_JSONB(v_request);
END;
$function$;

REVOKE ALL ON FUNCTION public.review_approval_request(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_approval_request(UUID, TEXT, UUID, TEXT)
    TO service_role;

COMMIT;
