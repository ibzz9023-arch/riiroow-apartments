-- Atomic financial operations. Install only after reviewing the live schema.

BEGIN;

DROP FUNCTION IF EXISTS public.create_financial_expense(
    UUID, UUID, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, UUID, UUID, TEXT
);

CREATE OR REPLACE FUNCTION public.assert_financial_actor(p_actor_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
    IF p_actor_id IS NULL OR NOT EXISTS (
        SELECT 1
          FROM public.users
         WHERE id = p_actor_id
           AND is_active = TRUE
           AND role IN ('Admin', 'Manager')
    ) THEN
        RAISE EXCEPTION 'An active Manager or Admin is required.'
            USING ERRCODE = '42501';
    END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.create_financial_expense_category(
    p_name TEXT,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_category public.financial_expense_categories%ROWTYPE;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    PERFORM pg_advisory_xact_lock(20261114, 1);
    IF p_name IS NULL OR LENGTH(BTRIM(p_name)) = 0 OR LENGTH(p_name) > 80 THEN
        RAISE EXCEPTION 'Category name is required and must be at most 80 characters.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.financial_expense_categories (name, created_by)
    VALUES (BTRIM(p_name), p_recorded_by)
    RETURNING * INTO v_category;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, details
    )
    VALUES (
        'financial_expense_category',
        v_category.id,
        'created',
        p_recorded_by,
        JSONB_BUILD_OBJECT('name', v_category.name)
    );

    RETURN JSONB_BUILD_OBJECT('success', TRUE, 'category', TO_JSONB(v_category));
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_financial_expense(
    p_property_id UUID,
    p_category_id UUID,
    p_amount NUMERIC,
    p_description TEXT,
    p_expense_on DATE,
    p_paid_on DATE,
    p_payment_method TEXT,
    p_transaction_reference TEXT,
    p_receipt_storage_path TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID,
    p_status TEXT DEFAULT 'paid'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_expense public.financial_expenses%ROWTYPE;
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_expense_on IS NULL OR p_expense_on > v_today THEN
        RAISE EXCEPTION 'A valid expense date no later than today is required.'
            USING ERRCODE = '22023';
    END IF;
    IF p_amount IS NULL
       OR p_amount::text = 'NaN'
       OR p_amount <= 0
       OR p_amount > 1000000000
       OR p_amount <> ROUND(p_amount, 2) THEN
        RAISE EXCEPTION 'Expense amount must be positive and valid to two decimal places.'
            USING ERRCODE = '22023';
    END IF;
    IF p_status NOT IN ('paid', 'unpaid')
       OR (p_status = 'paid' AND (p_paid_on IS NULL OR p_paid_on > v_today))
       OR (p_status = 'unpaid' AND p_paid_on IS NOT NULL) THEN
        RAISE EXCEPTION 'Expense status and actual payment date are inconsistent.'
            USING ERRCODE = '22023';
    END IF;
    IF p_description IS NULL
       OR LENGTH(BTRIM(p_description)) = 0
       OR LENGTH(p_description) > 2000 THEN
        RAISE EXCEPTION 'Expense description is required and must be at most 2000 characters.'
            USING ERRCODE = '22023';
    END IF;
    IF p_payment_method IS NOT NULL AND p_payment_method NOT IN (
        'Cash', 'Bank Transfer', 'Mobile Money', 'Other'
    ) THEN
        RAISE EXCEPTION 'Invalid expense payment method.'
            USING ERRCODE = '22023';
    END IF;
    IF p_receipt_storage_path IS NOT NULL
       AND LENGTH(p_receipt_storage_path) > 500 THEN
        RAISE EXCEPTION 'Expense receipt storage path is too long.'
            USING ERRCODE = '22023';
    END IF;
    IF p_transaction_reference IS NOT NULL
       AND LENGTH(p_transaction_reference) > 200 THEN
        RAISE EXCEPTION 'Expense transaction reference is too long.'
            USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.financial_expense_categories
         WHERE id = p_category_id AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Active expense category not found.'
            USING ERRCODE = 'P0002';
    END IF;

    v_request := jsonb_build_object(
        'propertyId', p_property_id,
        'categoryId', p_category_id,
        'amount', p_amount,
        'description', BTRIM(p_description),
        'expenseOn', p_expense_on,
        'paidOn', p_paid_on,
        'paymentMethod', p_payment_method,
        'reference', p_transaction_reference,
        'receiptPath', p_receipt_storage_path,
        'status', p_status
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key, 'create_financial_expense', v_request, p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    INSERT INTO public.financial_expenses (
        property_id,
        category_id,
        amount,
        description,
        expense_on,
        payment_method,
        transaction_reference,
        paid_on,
        status,
        receipt_storage_path,
        idempotency_key,
        recorded_by
    )
    VALUES (
        p_property_id,
        p_category_id,
        p_amount,
        BTRIM(p_description),
        p_expense_on,
        p_payment_method,
        NULLIF(BTRIM(p_transaction_reference), ''),
        p_paid_on,
        p_status,
        p_receipt_storage_path,
        p_idempotency_key,
        p_recorded_by
    )
    RETURNING * INTO v_expense;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, details
    )
    VALUES (
        'financial_expense',
        v_expense.id,
        'created',
        p_recorded_by,
        jsonb_build_object(
            'amount', p_amount,
            'categoryId', p_category_id,
            'expenseOn', p_expense_on,
            'paidOn', p_paid_on,
            'status', p_status
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'expense', to_jsonb(v_expense)
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_rent_receipt(
    p_receipt_id UUID,
    p_voided_on DATE,
    p_reason TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_receipt public.rent_receipts%ROWTYPE;
    v_account public.tenant_credit_accounts%ROWTYPE;
    v_credit RECORD;
    v_allocation RECORD;
    v_remaining_credit NUMERIC(12,2);
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_voided_on IS NULL OR p_voided_on > v_today
       OR p_reason IS NULL OR LENGTH(BTRIM(p_reason)) = 0 OR LENGTH(p_reason) > 1000 THEN
        RAISE EXCEPTION 'A valid void date and reason are required.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object(
        'receiptId', p_receipt_id,
        'voidedOn', p_voided_on,
        'reason', BTRIM(p_reason)
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key, 'void_rent_receipt', v_request, p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    SELECT *
      INTO v_receipt
      FROM public.rent_receipts
     WHERE id = p_receipt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rent receipt not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT *
      INTO v_account
      FROM public.tenant_credit_accounts
     WHERE tenant_id = v_receipt.tenant_id
       AND property_id = v_receipt.property_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant credit account not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_account.balance <> COALESCE((
        SELECT SUM(amount)
          FROM public.tenant_credit_transactions
         WHERE account_id = v_account.id
    ), 0) THEN
        RAISE EXCEPTION 'Tenant credit account requires reconciliation.'
            USING ERRCODE = '40001';
    END IF;

    SELECT *
      INTO v_receipt
      FROM public.rent_receipts
     WHERE id = p_receipt_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rent receipt not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_receipt.status <> 'posted' THEN
        RAISE EXCEPTION 'Only a posted receipt can be voided.'
            USING ERRCODE = '23505';
    END IF;

    -- Lock order: idempotency, tenant credit account, receipt, credit rows,
    -- then rent obligations in payment-id order.
    FOR v_credit IN
        SELECT *
          FROM public.tenant_credit_transactions
         WHERE source_receipt_id = p_receipt_id
           AND event_type = 'issued'
         ORDER BY id
         FOR UPDATE
    LOOP
        SELECT ROUND(
            v_credit.amount + COALESCE(SUM(amount), 0),
            2
        )
          INTO v_remaining_credit
          FROM public.tenant_credit_transactions
         WHERE credit_source_transaction_id = v_credit.id;
        IF v_remaining_credit <> v_credit.amount THEN
            RAISE EXCEPTION 'Receipt credit has already been applied or refunded; use a compensating correction.'
                USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.tenant_credit_transactions (
            account_id,
            event_type,
            amount,
            effective_on,
            credit_source_transaction_id,
            reverses_transaction_id,
            idempotency_key,
            recorded_by,
            reason
        )
        VALUES (
            v_account.id,
            'reversal',
            -v_credit.amount,
            p_voided_on,
            v_credit.id,
            v_credit.id,
            p_idempotency_key,
            p_recorded_by,
            BTRIM(p_reason)
        );

        UPDATE public.tenant_credit_accounts
           SET balance = balance - v_credit.amount,
               updated_at = NOW()
         WHERE id = v_account.id;
    END LOOP;

    FOR v_allocation IN
        SELECT a.id, a.payment_id, a.allocated_amount
          FROM public.rent_receipt_allocations AS a
         WHERE a.receipt_id = p_receipt_id
         ORDER BY a.payment_id, a.id
         FOR UPDATE
    LOOP
        INSERT INTO public.rent_receipt_allocation_reversals (
            allocation_id,
            amount,
            reversed_on,
            idempotency_key,
            reason,
            recorded_by
        )
        VALUES (
            v_allocation.id,
            v_allocation.allocated_amount,
            p_voided_on,
            p_idempotency_key,
            BTRIM(p_reason),
            p_recorded_by
        );
    END LOOP;

    UPDATE public.rent_receipts
       SET status = 'voided',
           voided_by = p_recorded_by,
           voided_at = NOW(),
           void_reason = BTRIM(p_reason),
           void_idempotency_key = p_idempotency_key
     WHERE id = p_receipt_id;

    FOR v_allocation IN
        SELECT DISTINCT payment_id
          FROM public.rent_receipt_allocations
         WHERE receipt_id = p_receipt_id
         ORDER BY payment_id
    LOOP
        PERFORM public.rebuild_financial_payment_projection(
            v_allocation.payment_id, p_voided_on, NULL
        );
    END LOOP;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'rent_receipt',
        p_receipt_id,
        'voided',
        p_recorded_by,
        BTRIM(p_reason),
        jsonb_build_object('amount', v_receipt.amount, 'voidedOn', p_voided_on)
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'receiptId', p_receipt_id,
        'status', 'voided'
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

-- Positive notification actions must use record_rent_receipt so the review and
-- receipt ledger are committed atomically with an explicit actual receipt date.
CREATE OR REPLACE FUNCTION public.review_payment_notification(
    p_notification_id UUID,
    p_action TEXT,
    p_reviewed_by TEXT DEFAULT NULL,
    p_review_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_notification public.payment_notifications%ROWTYPE;
    v_actor_id UUID;
BEGIN
    IF p_action IS NULL OR p_action <> 'Rejected' THEN
        RAISE EXCEPTION 'Receipt recording requires the financial receipt endpoint and manager-confirmed actual receipt date.'
            USING ERRCODE = '22023';
    END IF;
    IF p_reviewed_by IS NULL
       OR p_reviewed_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'A valid reviewer identity is required.'
            USING ERRCODE = '42501';
    END IF;
    v_actor_id := p_reviewed_by::uuid;
    PERFORM public.assert_financial_actor(v_actor_id);
    PERFORM pg_advisory_xact_lock(20261114, 1);

    SELECT *
      INTO v_notification
      FROM public.payment_notifications
     WHERE id = p_notification_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment notification not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_notification.status <> 'Pending Verification' THEN
        RAISE EXCEPTION 'This notification has already been reviewed.'
            USING ERRCODE = '23505';
    END IF;

    IF p_action = 'Rejected' THEN
        UPDATE public.payment_notifications
           SET status = 'Rejected',
               reviewed_at = NOW(),
               reviewed_by = p_reviewed_by,
               review_note = p_review_note
         WHERE id = p_notification_id;
        RETURN JSONB_BUILD_OBJECT(
            'success', TRUE,
            'status', 'Rejected',
            'notificationId', p_notification_id
        );
    END IF;

    UPDATE public.payment_notifications
       SET status = 'Verified - Awaiting Rent Recording',
           recording_mode = 'Manual',
           reviewed_at = NOW(),
           reviewed_by = p_reviewed_by,
           review_note = p_review_note
     WHERE id = p_notification_id;

    RETURN JSONB_BUILD_OBJECT(
        'success', TRUE,
        'status', 'Verified - Awaiting Rent Recording',
        'recordingMode', 'Manual',
        'notificationId', p_notification_id
    );
END;
$function$;
CREATE OR REPLACE FUNCTION public.void_financial_expense(
    p_expense_id UUID,
    p_reason TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_expense public.financial_expenses%ROWTYPE;
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_reason IS NULL OR LENGTH(BTRIM(p_reason)) = 0 OR LENGTH(p_reason) > 1000 THEN
        RAISE EXCEPTION 'A void reason is required and must be at most 1000 characters.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object('expenseId', p_expense_id, 'reason', BTRIM(p_reason));
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key, 'void_financial_expense', v_request, p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    SELECT *
      INTO v_expense
      FROM public.financial_expenses
     WHERE id = p_expense_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_expense.status = 'voided' THEN
        RAISE EXCEPTION 'Expense has already been voided.'
            USING ERRCODE = '23505';
    END IF;

    UPDATE public.financial_expenses
       SET status = 'voided',
           voided_by = p_recorded_by,
           voided_at = NOW(),
           void_reason = BTRIM(p_reason)
     WHERE id = p_expense_id
    RETURNING * INTO v_expense;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'financial_expense',
        p_expense_id,
        'voided',
        p_recorded_by,
        BTRIM(p_reason),
        jsonb_build_object(
            'amount', v_expense.amount,
            'paidOn', v_expense.paid_on,
            'categoryId', v_expense.category_id
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'expense', to_jsonb(v_expense)
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_month_summary_at(
    p_period_start DATE,
    p_source_cutoff TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_period_end DATE;
    v_cash_collected NUMERIC(14,2);
    v_cash_refunded NUMERIC(14,2);
    v_rent_income NUMERIC(14,2);
    v_paid_expenses NUMERIC(14,2);
    v_credit_liability NUMERIC(14,2);
    v_undated_legacy NUMERIC(14,2);
    v_excluded_unverified NUMERIC(14,2);
    v_expense_breakdown JSONB;
    v_warnings JSONB := '[]'::jsonb;
    v_pending_notifications BIGINT := 0;
    v_unbalanced_receipts BIGINT := 0;
    v_credit_account_mismatches BIGINT := 0;
    v_incomplete_operations BIGINT := 0;
BEGIN
    IF p_period_start IS NULL
       OR p_period_start <> DATE_TRUNC('month', p_period_start)::date
       OR p_source_cutoff IS NULL THEN
        RAISE EXCEPTION 'A month start and source cutoff are required.'
            USING ERRCODE = '22023';
    END IF;
    v_period_end := (p_period_start + INTERVAL '1 month - 1 day')::date;

    SELECT COALESCE(SUM(amount), 0)
        + COALESCE((
            SELECT SUM(legacy_amount)
              FROM public.rent_legacy_balances
             WHERE classification = 'reconciled'
               AND reconciled_at <= p_source_cutoff
               AND source_paid_date BETWEEN p_period_start AND v_period_end
        ), 0)
      INTO v_cash_collected
      FROM public.rent_receipts
     WHERE recorded_at <= p_source_cutoff
       AND (
           status = 'posted'
           OR (status = 'voided' AND voided_at > p_source_cutoff)
       )
       AND received_on BETWEEN p_period_start AND v_period_end;

    SELECT COALESCE(SUM(amount), 0)
      INTO v_cash_refunded
      FROM public.rent_cash_refunds
     WHERE created_at <= p_source_cutoff
       AND refunded_on BETWEEN p_period_start AND v_period_end;

    SELECT
        COALESCE((
            SELECT SUM(a.allocated_amount)
              FROM public.rent_receipt_allocations AS a
              JOIN public.rent_receipts AS r ON r.id = a.receipt_id
             WHERE a.created_at <= p_source_cutoff
               AND r.recorded_at <= p_source_cutoff
               AND (
                   r.status = 'posted'
                   OR (r.status = 'voided' AND r.voided_at > p_source_cutoff)
               )
               AND a.allocated_on BETWEEN p_period_start AND v_period_end
        ), 0)
        - COALESCE((
            SELECT SUM(rv.amount)
              FROM public.rent_receipt_allocation_reversals AS rv
              JOIN public.rent_receipt_allocations AS a ON a.id = rv.allocation_id
              JOIN public.rent_receipts AS r ON r.id = a.receipt_id
             WHERE rv.created_at <= p_source_cutoff
               AND a.created_at <= p_source_cutoff
               AND r.recorded_at <= p_source_cutoff
               AND (
                   r.status = 'posted'
                   OR (r.status = 'voided' AND r.voided_at > p_source_cutoff)
               )
               AND rv.reversed_on BETWEEN p_period_start AND v_period_end
        ), 0)
        - COALESCE((
            SELECT SUM(t.amount)
              FROM public.tenant_credit_transactions AS t
             WHERE t.payment_id IS NOT NULL
               AND t.event_type IN ('application', 'reversal')
               AND t.created_at <= p_source_cutoff
               AND t.effective_on BETWEEN p_period_start AND v_period_end
        ), 0)
        + COALESCE((
            SELECT SUM(legacy_amount)
              FROM public.rent_legacy_balances
             WHERE classification = 'reconciled'
               AND reconciled_at <= p_source_cutoff
               AND source_paid_date BETWEEN p_period_start AND v_period_end
        ), 0)
      INTO v_rent_income;

    SELECT COALESCE(SUM(amount), 0)
      INTO v_paid_expenses
      FROM public.financial_expenses
     WHERE recorded_at <= p_source_cutoff
       AND (
           status = 'paid'
           OR (status = 'voided' AND voided_at > p_source_cutoff AND paid_on IS NOT NULL)
       )
       AND paid_on BETWEEN p_period_start AND v_period_end;

    SELECT COALESCE(SUM(amount), 0)
      INTO v_credit_liability
      FROM public.tenant_credit_transactions
     WHERE created_at <= p_source_cutoff
       AND effective_on <= v_period_end;

    SELECT COALESCE(SUM(legacy_amount), 0)
      INTO v_undated_legacy
      FROM public.rent_legacy_balances
     WHERE created_at <= p_source_cutoff
       AND (
           classification = 'undated'
           OR (
               classification = 'reconciled'
               AND reconciled_at > p_source_cutoff
               AND LOWER(COALESCE(verification_status, '')) NOT IN (
                   'pending verification', 'rejected'
               )
           )
       );

    SELECT COALESCE(SUM(legacy_amount), 0)
      INTO v_excluded_unverified
      FROM public.rent_legacy_balances
     WHERE created_at <= p_source_cutoff
       AND (
           classification = 'excluded_unverified'
           OR (
               classification = 'reconciled'
               AND reconciled_at > p_source_cutoff
               AND LOWER(COALESCE(verification_status, '')) IN (
                   'pending verification', 'rejected'
               )
           )
       );

    SELECT COALESCE(
        JSONB_OBJECT_AGG(category_name, category_total),
        '{}'::jsonb
    )
      INTO v_expense_breakdown
      FROM (
          SELECT c.name AS category_name, SUM(e.amount) AS category_total
            FROM public.financial_expenses AS e
            JOIN public.financial_expense_categories AS c ON c.id = e.category_id
           WHERE e.recorded_at <= p_source_cutoff
             AND (
                 e.status = 'paid'
                 OR (e.status = 'voided' AND e.voided_at > p_source_cutoff AND e.paid_on IS NOT NULL)
             )
             AND e.paid_on BETWEEN p_period_start AND v_period_end
           GROUP BY c.name
      ) AS category_totals;

    SELECT COUNT(*)
      INTO v_pending_notifications
      FROM public.payment_notifications AS n
     WHERE n.submitted_at <= p_source_cutoff
       AND (
           n.status IN (
               'Pending Verification',
               'Verified',
               'Verified - Awaiting Rent Recording'
           )
           OR (n.status = 'Rejected' AND n.reviewed_at > p_source_cutoff)
           OR (
               n.status = 'Verified - Rent Recorded'
               AND (
                   n.recorded_at IS NULL
                   OR n.recorded_at > p_source_cutoff
                   OR NOT EXISTS (
                       SELECT 1
                         FROM public.rent_receipts AS r
                        WHERE r.payment_notification_id = n.id
                          AND r.recorded_at <= p_source_cutoff
                          AND (
                              r.status = 'posted'
                              OR (r.status = 'voided' AND r.voided_at > p_source_cutoff)
                          )
                   )
               )
           )
       );

    SELECT COUNT(*)
      INTO v_unbalanced_receipts
      FROM public.rent_receipts AS r
     WHERE r.recorded_at <= p_source_cutoff
       AND (
           r.status = 'posted'
           OR (r.status = 'voided' AND r.voided_at > p_source_cutoff)
       )
       AND ROUND(r.amount, 2) <> ROUND(
           COALESCE((
               SELECT SUM(a.allocated_amount - COALESCE((
                   SELECT SUM(rv.amount)
                     FROM public.rent_receipt_allocation_reversals AS rv
                    WHERE rv.allocation_id = a.id
                      AND rv.created_at <= p_source_cutoff
               ), 0))
                 FROM public.rent_receipt_allocations AS a
                WHERE a.receipt_id = r.id
                  AND a.created_at <= p_source_cutoff
           ), 0)
           + COALESCE((
               SELECT SUM(t.amount)
                 FROM public.tenant_credit_transactions AS t
                WHERE t.source_receipt_id = r.id
                  AND t.event_type = 'issued'
                  AND t.created_at <= p_source_cutoff
           ), 0),
           2
       );

    SELECT COUNT(*)
      INTO v_credit_account_mismatches
      FROM public.tenant_credit_accounts AS a
     WHERE a.updated_at <= p_source_cutoff
       AND ROUND(a.balance, 2) <> ROUND(COALESCE((
           SELECT SUM(t.amount)
             FROM public.tenant_credit_transactions AS t
            WHERE t.account_id = a.id
              AND t.created_at <= p_source_cutoff
       ), 0), 2);

    SELECT COUNT(*)
      INTO v_incomplete_operations
      FROM public.financial_idempotency_records AS i
     WHERE i.created_at <= p_source_cutoff
       AND i.response_payload IS NULL;

    IF v_undated_legacy > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            'Undated historical payment balances are excluded from monthly rent income.'
        );
    END IF;
    IF v_excluded_unverified > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            'Historical paid amounts with pending or rejected verification require reconciliation.'
        );
    END IF;
    IF v_pending_notifications > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            FORMAT('%s payment notification(s) remain unresolved.', v_pending_notifications)
        );
    END IF;
    IF v_unbalanced_receipts > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            FORMAT('%s receipt(s) do not reconcile to rent allocations and tenant credits.', v_unbalanced_receipts)
        );
    END IF;
    IF v_credit_account_mismatches > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            FORMAT('%s tenant credit account(s) do not reconcile to their transaction ledgers.', v_credit_account_mismatches)
        );
    END IF;
    IF v_incomplete_operations > 0 THEN
        v_warnings := v_warnings || JSONB_BUILD_ARRAY(
            FORMAT('%s financial operation(s) have no stored completion response.', v_incomplete_operations)
        );
    END IF;

    RETURN JSONB_BUILD_OBJECT(
        'periodStart', p_period_start,
        'periodEnd', v_period_end,
        'sourceCutoff', p_source_cutoff,
        'currency', 'USD',
        'reportingTimezone', 'Africa/Mogadishu',
        'cashCollected', ROUND(v_cash_collected, 2),
        'cashRefunded', ROUND(v_cash_refunded, 2),
        'rentIncomeRecognized', ROUND(v_rent_income, 2),
        'paidExpenses', ROUND(v_paid_expenses, 2),
        'netProfit', ROUND(v_rent_income - v_paid_expenses, 2),
        'tenantCreditLiability', ROUND(v_credit_liability, 2),
        'undatedLegacyBalances', ROUND(v_undated_legacy, 2),
        'excludedUnverifiedBalances', ROUND(v_excluded_unverified, 2),
        'pendingNotificationCount', v_pending_notifications,
        'unbalancedReceiptCount', v_unbalanced_receipts,
        'creditAccountMismatchCount', v_credit_account_mismatches,
        'incompleteOperationCount', v_incomplete_operations,
        'expenseBreakdown', v_expense_breakdown,
        'isComplete',
            v_undated_legacy = 0
            AND v_excluded_unverified = 0
            AND v_pending_notifications = 0
            AND v_unbalanced_receipts = 0
            AND v_credit_account_mismatches = 0
            AND v_incomplete_operations = 0,
        'completenessWarnings', v_warnings
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_month_summary(p_period_start DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(20261114, 1);
    RETURN public.financial_month_summary_at(p_period_start, NOW());
END;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_financial_month_snapshot(
    p_period_start DATE,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_snapshot public.financial_monthly_snapshots%ROWTYPE;
    v_version public.financial_monthly_snapshot_versions%ROWTYPE;
    v_summary JSONB;
    v_version_number INTEGER;
    v_source_cutoff TIMESTAMPTZ;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    PERFORM pg_advisory_xact_lock(20261114, 1);
    v_source_cutoff := NOW();
    v_summary := public.financial_month_summary_at(p_period_start, v_source_cutoff);

    INSERT INTO public.financial_monthly_snapshots (period_start, created_by)
    VALUES (p_period_start, p_recorded_by)
    ON CONFLICT (period_start) DO NOTHING;

    SELECT *
      INTO v_snapshot
      FROM public.financial_monthly_snapshots
     WHERE period_start = p_period_start
     FOR UPDATE;

    SELECT *
      INTO v_version
      FROM public.financial_monthly_snapshot_versions
     WHERE snapshot_id = v_snapshot.id
       AND status = 'draft'
     ORDER BY version_number DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
        UPDATE public.financial_monthly_snapshot_versions
           SET cash_collected = (v_summary->>'cashCollected')::numeric,
               cash_refunded = (v_summary->>'cashRefunded')::numeric,
               rent_income_recognized = (v_summary->>'rentIncomeRecognized')::numeric,
               paid_expenses = (v_summary->>'paidExpenses')::numeric,
               net_profit = (v_summary->>'netProfit')::numeric,
               tenant_credit_liability = (v_summary->>'tenantCreditLiability')::numeric,
               undated_legacy_balances = (v_summary->>'undatedLegacyBalances')::numeric,
               excluded_unverified_balances = (v_summary->>'excludedUnverifiedBalances')::numeric,
               expense_breakdown = v_summary->'expenseBreakdown',
               completeness_warnings = v_summary->'completenessWarnings',
               is_complete = (v_summary->>'isComplete')::boolean,
               source_cutoff = v_source_cutoff,
               prepared_by = p_recorded_by,
               prepared_at = NOW()
         WHERE id = v_version.id
        RETURNING * INTO v_version;
    ELSE
        SELECT COALESCE(MAX(version_number), 0) + 1
          INTO v_version_number
          FROM public.financial_monthly_snapshot_versions
         WHERE snapshot_id = v_snapshot.id;

        INSERT INTO public.financial_monthly_snapshot_versions (
            snapshot_id,
            version_number,
            supersedes_version_id,
            cash_collected,
            cash_refunded,
            rent_income_recognized,
            paid_expenses,
            net_profit,
            tenant_credit_liability,
            undated_legacy_balances,
            excluded_unverified_balances,
            expense_breakdown,
            completeness_warnings,
            is_complete,
            source_cutoff,
            prepared_by
        )
        VALUES (
            v_snapshot.id,
            v_version_number,
            v_snapshot.current_finalized_version_id,
            (v_summary->>'cashCollected')::numeric,
            (v_summary->>'cashRefunded')::numeric,
            (v_summary->>'rentIncomeRecognized')::numeric,
            (v_summary->>'paidExpenses')::numeric,
            (v_summary->>'netProfit')::numeric,
            (v_summary->>'tenantCreditLiability')::numeric,
            (v_summary->>'undatedLegacyBalances')::numeric,
            (v_summary->>'excludedUnverifiedBalances')::numeric,
            v_summary->'expenseBreakdown',
            v_summary->'completenessWarnings',
            (v_summary->>'isComplete')::boolean,
            v_source_cutoff,
            p_recorded_by
        )
        RETURNING * INTO v_version;
    END IF;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, details
    )
    VALUES (
        'financial_snapshot_version',
        v_version.id,
        'prepared',
        p_recorded_by,
        jsonb_build_object(
            'periodStart', p_period_start,
            'versionNumber', v_version.version_number,
            'isComplete', v_version.is_complete
        )
    );

    RETURN JSONB_BUILD_OBJECT(
        'success', TRUE,
        'snapshotId', v_snapshot.id,
        'version', TO_JSONB(v_version)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_financial_month_snapshot(
    p_version_id UUID,
    p_acknowledge_incomplete BOOLEAN,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_version public.financial_monthly_snapshot_versions%ROWTYPE;
    v_snapshot public.financial_monthly_snapshots%ROWTYPE;
    v_snapshot_id UUID;
    v_current_summary JSONB;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    PERFORM pg_advisory_xact_lock(20261114, 1);

    SELECT snapshot_id
      INTO v_snapshot_id
      FROM public.financial_monthly_snapshot_versions
     WHERE id = p_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Snapshot version not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT *
      INTO v_snapshot
      FROM public.financial_monthly_snapshots
     WHERE id = v_snapshot_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Financial snapshot not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT *
      INTO v_version
      FROM public.financial_monthly_snapshot_versions
     WHERE id = p_version_id
       AND snapshot_id = v_snapshot_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Snapshot version not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_version.status <> 'draft' THEN
        RAISE EXCEPTION 'Only a draft snapshot version can be finalized.'
            USING ERRCODE = '23505';
    END IF;

    v_current_summary := public.financial_month_summary_at(
        v_snapshot.period_start,
        NOW()
    );
    IF v_version.cash_collected IS DISTINCT FROM (v_current_summary->>'cashCollected')::numeric
       OR v_version.cash_refunded IS DISTINCT FROM (v_current_summary->>'cashRefunded')::numeric
       OR v_version.rent_income_recognized IS DISTINCT FROM (v_current_summary->>'rentIncomeRecognized')::numeric
       OR v_version.paid_expenses IS DISTINCT FROM (v_current_summary->>'paidExpenses')::numeric
       OR v_version.net_profit IS DISTINCT FROM (v_current_summary->>'netProfit')::numeric
       OR v_version.tenant_credit_liability IS DISTINCT FROM (v_current_summary->>'tenantCreditLiability')::numeric
       OR v_version.undated_legacy_balances IS DISTINCT FROM (v_current_summary->>'undatedLegacyBalances')::numeric
       OR v_version.excluded_unverified_balances IS DISTINCT FROM (v_current_summary->>'excludedUnverifiedBalances')::numeric
       OR v_version.expense_breakdown IS DISTINCT FROM v_current_summary->'expenseBreakdown'
       OR v_version.completeness_warnings IS DISTINCT FROM v_current_summary->'completenessWarnings'
       OR v_version.is_complete IS DISTINCT FROM (v_current_summary->>'isComplete')::boolean THEN
        RAISE EXCEPTION 'Snapshot source data changed after preparation; prepare a new snapshot version.'
            USING ERRCODE = '40001';
    END IF;

    IF NOT v_version.is_complete AND p_acknowledge_incomplete IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Explicit acknowledgement is required to finalize an incomplete snapshot.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.financial_monthly_snapshot_versions
       SET status = 'finalized',
           finalized_by = p_recorded_by,
           finalized_at = NOW(),
           incomplete_acknowledged_by = CASE
               WHEN is_complete THEN NULL ELSE p_recorded_by
           END,
           incomplete_acknowledged_at = CASE
               WHEN is_complete THEN NULL ELSE NOW()
           END
     WHERE id = p_version_id
    RETURNING * INTO v_version;

    UPDATE public.financial_monthly_snapshots
       SET current_finalized_version_id = p_version_id
     WHERE id = v_snapshot.id;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, details
    )
    VALUES (
        'financial_snapshot_version',
        p_version_id,
        'finalized',
        p_recorded_by,
        jsonb_build_object(
            'snapshotId', v_snapshot.id,
            'versionNumber', v_version.version_number,
            'acknowledgedIncomplete', NOT v_version.is_complete
        )
    );

    RETURN JSONB_BUILD_OBJECT(
        'success', TRUE,
        'snapshotId', v_snapshot.id,
        'version', TO_JSONB(v_version)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_tenant_credit(
    p_tenant_id UUID,
    p_property_id UUID,
    p_payment_id UUID,
    p_amount NUMERIC,
    p_applied_on DATE,
    p_idempotency_key UUID,
    p_recorded_by UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_account public.tenant_credit_accounts%ROWTYPE;
    v_payment public.payments%ROWTYPE;
    v_credit RECORD;
    v_available NUMERIC(12,2);
    v_remaining NUMERIC(12,2);
    v_due NUMERIC(12,2);
    v_apply NUMERIC(12,2);
    v_applied NUMERIC(12,2) := 0;
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_amount IS NULL
       OR p_amount::text = 'NaN'
       OR p_amount <= 0
       OR p_amount > 1000000000
       OR p_amount <> ROUND(p_amount, 2)
       OR p_applied_on IS NULL
       OR p_applied_on > v_today THEN
        RAISE EXCEPTION 'Credit application amount and date are invalid.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object(
        'tenantId', p_tenant_id,
        'propertyId', p_property_id,
        'paymentId', p_payment_id,
        'amount', p_amount,
        'appliedOn', p_applied_on,
        'reason', p_reason
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key, 'apply_tenant_credit', v_request, p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    SELECT *
      INTO v_account
      FROM public.tenant_credit_accounts
     WHERE tenant_id = p_tenant_id
       AND property_id = p_property_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant credit account not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_account.balance <> COALESCE((
        SELECT SUM(amount)
          FROM public.tenant_credit_transactions
         WHERE account_id = v_account.id
    ), 0) THEN
        RAISE EXCEPTION 'Tenant credit account requires reconciliation.'
            USING ERRCODE = '40001';
    END IF;

    SELECT *
      INTO v_payment
      FROM public.payments
     WHERE id = p_payment_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rent obligation not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_payment.tenant_id <> p_tenant_id
       OR v_payment.property_id <> p_property_id THEN
        RAISE EXCEPTION 'Rent obligation does not match the tenant credit account.'
            USING ERRCODE = '22023';
    END IF;

    v_due := ROUND(
        GREATEST(
            0,
            v_payment.amount - public.financial_payment_paid_amount(v_payment.id)
        ),
        2
    );
    IF p_amount > v_due THEN
        RAISE EXCEPTION 'Credit application exceeds the outstanding rent balance.'
            USING ERRCODE = '22023';
    END IF;
    IF p_amount > v_account.balance THEN
        RAISE EXCEPTION 'Credit application exceeds the available tenant credit.'
            USING ERRCODE = '22023';
    END IF;

    v_remaining := p_amount;
    FOR v_credit IN
        SELECT id, amount
          FROM public.tenant_credit_transactions
         WHERE account_id = v_account.id
           AND event_type = 'issued'
         ORDER BY effective_on, created_at, id
         FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        SELECT ROUND(
            v_credit.amount + COALESCE(SUM(amount), 0),
            2
        )
          INTO v_available
          FROM public.tenant_credit_transactions
         WHERE credit_source_transaction_id = v_credit.id;

        v_apply := LEAST(v_remaining, GREATEST(0, v_available));
        IF v_apply > 0 THEN
            INSERT INTO public.tenant_credit_transactions (
                account_id,
                event_type,
                amount,
                effective_on,
                credit_source_transaction_id,
                payment_id,
                idempotency_key,
                recorded_by,
                reason
            )
            VALUES (
                v_account.id,
                'application',
                -v_apply,
                p_applied_on,
                v_credit.id,
                p_payment_id,
                p_idempotency_key,
                p_recorded_by,
                p_reason
            );
            v_remaining := ROUND(v_remaining - v_apply, 2);
            v_applied := ROUND(v_applied + v_apply, 2);
        END IF;
    END LOOP;

    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Tenant credit is insufficient for this application.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.tenant_credit_accounts
       SET balance = balance - v_applied,
           updated_at = NOW()
     WHERE id = v_account.id;

    PERFORM public.rebuild_financial_payment_projection(
        p_payment_id, p_applied_on, NULL
    );

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'tenant_credit_account',
        v_account.id,
        'applied',
        p_recorded_by,
        p_reason,
        jsonb_build_object(
            'paymentId', p_payment_id,
            'amount', v_applied,
            'appliedOn', p_applied_on
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'accountId', v_account.id,
        'paymentId', p_payment_id,
        'appliedAmount', v_applied,
        'balance', v_account.balance - v_applied
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_tenant_credit(
    p_tenant_id UUID,
    p_property_id UUID,
    p_credit_transaction_id UUID,
    p_amount NUMERIC,
    p_refunded_on DATE,
    p_payment_method TEXT,
    p_transaction_reference TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_account public.tenant_credit_accounts%ROWTYPE;
    v_credit public.tenant_credit_transactions%ROWTYPE;
    v_available NUMERIC(12,2);
    v_transaction_id UUID;
    v_refund_id UUID := gen_random_uuid();
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_amount IS NULL
       OR p_amount::text = 'NaN'
       OR p_amount <= 0
       OR p_amount > 1000000000
       OR p_amount <> ROUND(p_amount, 2)
       OR p_refunded_on IS NULL
       OR p_refunded_on > v_today THEN
        RAISE EXCEPTION 'Credit refund amount and date are invalid.'
            USING ERRCODE = '22023';
    END IF;
    IF p_payment_method IS NULL OR p_payment_method NOT IN (
        'Cash', 'Bank Transfer', 'Mobile Money', 'Other'
    ) THEN
        RAISE EXCEPTION 'Invalid refund payment method.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object(
        'tenantId', p_tenant_id,
        'propertyId', p_property_id,
        'creditTransactionId', p_credit_transaction_id,
        'amount', p_amount,
        'refundedOn', p_refunded_on,
        'paymentMethod', p_payment_method,
        'transactionReference', p_transaction_reference,
        'reason', p_reason
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key, 'refund_tenant_credit', v_request, p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    SELECT *
      INTO v_account
      FROM public.tenant_credit_accounts
     WHERE tenant_id = p_tenant_id
       AND property_id = p_property_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant credit account not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_account.balance <> COALESCE((
        SELECT SUM(amount)
          FROM public.tenant_credit_transactions
         WHERE account_id = v_account.id
    ), 0) THEN
        RAISE EXCEPTION 'Tenant credit account requires reconciliation.'
            USING ERRCODE = '40001';
    END IF;

    SELECT *
      INTO v_credit
      FROM public.tenant_credit_transactions
     WHERE id = p_credit_transaction_id
       AND account_id = v_account.id
       AND event_type = 'issued'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original tenant credit transaction not found.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT ROUND(
        v_credit.amount + COALESCE(SUM(amount), 0),
        2
    )
      INTO v_available
      FROM public.tenant_credit_transactions
     WHERE credit_source_transaction_id = v_credit.id;
    IF p_amount > v_available OR p_amount > v_account.balance THEN
        RAISE EXCEPTION 'Refund exceeds the remaining tenant credit.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.tenant_credit_transactions (
        account_id,
        event_type,
        amount,
        effective_on,
        credit_source_transaction_id,
        idempotency_key,
        recorded_by,
        reason
    )
    VALUES (
        v_account.id,
        'refund',
        -p_amount,
        p_refunded_on,
        v_credit.id,
        p_idempotency_key,
        p_recorded_by,
        p_reason
    )
    RETURNING id INTO v_transaction_id;

    INSERT INTO public.rent_cash_refunds (
        id,
        credit_transaction_id,
        credit_source_transaction_id,
        amount,
        refunded_on,
        payment_method,
        transaction_reference,
        idempotency_key,
        recorded_by
    )
    VALUES (
        v_refund_id,
        v_transaction_id,
        v_credit.id,
        p_amount,
        p_refunded_on,
        p_payment_method,
        NULLIF(BTRIM(p_transaction_reference), ''),
        p_idempotency_key,
        p_recorded_by
    );

    UPDATE public.tenant_credit_accounts
       SET balance = balance - p_amount,
           updated_at = NOW()
     WHERE id = v_account.id;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'tenant_credit_account',
        v_account.id,
        'refunded',
        p_recorded_by,
        p_reason,
        jsonb_build_object(
            'creditTransactionId', v_credit.id,
            'refundTransactionId', v_transaction_id,
            'cashRefundId', v_refund_id,
            'amount', p_amount,
            'refundedOn', p_refunded_on
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'accountId', v_account.id,
        'creditTransactionId', v_transaction_id,
        'cashRefundId', v_refund_id,
        'amount', p_amount,
        'balance', v_account.balance - p_amount
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.begin_financial_operation(
    p_idempotency_key UUID,
    p_operation_type TEXT,
    p_request_payload JSONB,
    p_actor_id UUID
)
RETURNS TABLE(is_replay BOOLEAN, response_payload JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_inserted INTEGER;
    v_existing public.financial_idempotency_records%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(20261114, 1);

    IF p_idempotency_key IS NULL THEN
        RAISE EXCEPTION 'An idempotency key is required.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.financial_idempotency_records (
        idempotency_key,
        operation_type,
        request_payload,
        actor_id
    )
    VALUES (
        p_idempotency_key,
        p_operation_type,
        p_request_payload,
        p_actor_id
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 1 THEN
        RETURN QUERY SELECT FALSE, NULL::JSONB;
        RETURN;
    END IF;

    SELECT *
      INTO v_existing
      FROM public.financial_idempotency_records
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;

    IF v_existing.operation_type <> p_operation_type
       OR v_existing.request_payload <> p_request_payload THEN
        RAISE EXCEPTION 'The idempotency key was already used for a different request.'
            USING ERRCODE = '23505';
    END IF;

    IF v_existing.response_payload IS NULL THEN
        RAISE EXCEPTION 'The financial operation has not completed.'
            USING ERRCODE = '40001';
    END IF;

    RETURN QUERY SELECT TRUE, v_existing.response_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_rent_legacy_balance(
    p_balance_id UUID,
    p_source_paid_date DATE,
    p_evidence_note TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_balance public.rent_legacy_balances%ROWTYPE;
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_result JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);
    IF p_source_paid_date IS NULL OR p_source_paid_date > v_today THEN
        RAISE EXCEPTION 'A confirmed historical receipt date no later than today is required.'
            USING ERRCODE = '22023';
    END IF;
    IF p_evidence_note IS NULL
       OR LENGTH(BTRIM(p_evidence_note)) < 20
       OR LENGTH(p_evidence_note) > 1000 THEN
        RAISE EXCEPTION 'Reliable supporting evidence must be described in 20 to 1000 characters.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object(
        'balanceId', p_balance_id,
        'sourcePaidDate', p_source_paid_date,
        'evidenceNote', BTRIM(p_evidence_note)
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key,
          'reconcile_rent_legacy_balance',
          v_request,
          p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    SELECT *
      INTO v_balance
      FROM public.rent_legacy_balances
     WHERE id = p_balance_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Legacy rent balance not found.'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_balance.classification <> 'undated'
       OR LOWER(COALESCE(v_balance.verification_status, '')) IN (
           'pending verification', 'rejected'
       ) THEN
        RAISE EXCEPTION 'Only verified undated legacy balances can be reconciled.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.rent_legacy_balances
       SET classification = 'reconciled',
           source_paid_date = p_source_paid_date,
           evidence_note = BTRIM(p_evidence_note),
           reconciled_at = NOW(),
           reconciled_by = p_recorded_by
     WHERE id = p_balance_id
    RETURNING * INTO v_balance;

    PERFORM public.rebuild_financial_payment_projection(
        v_balance.payment_id,
        p_source_paid_date,
        NULL
    );

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'rent_legacy_balance',
        v_balance.id,
        'reconciled',
        p_recorded_by,
        BTRIM(p_evidence_note),
        jsonb_build_object(
            'paymentId', v_balance.payment_id,
            'amount', v_balance.legacy_amount,
            'sourcePaidDate', p_source_paid_date
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'balanceId', v_balance.id,
        'classification', v_balance.classification,
        'sourcePaidDate', v_balance.source_paid_date
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_payment_paid_amount(p_payment_id UUID)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
    SELECT
        COALESCE((
            SELECT SUM(legacy_amount)
              FROM public.rent_legacy_balances
             WHERE payment_id = p_payment_id
               AND classification IN ('undated', 'reconciled')
        ), 0)
        + COALESCE((
            SELECT SUM(a.allocated_amount)
              FROM public.rent_receipt_allocations AS a
              JOIN public.rent_receipts AS r ON r.id = a.receipt_id
             WHERE a.payment_id = p_payment_id
               AND r.status = 'posted'
        ), 0)
        - COALESCE((
            SELECT SUM(rv.amount)
              FROM public.rent_receipt_allocation_reversals AS rv
              JOIN public.rent_receipt_allocations AS a ON a.id = rv.allocation_id
              JOIN public.rent_receipts AS r ON r.id = a.receipt_id
             WHERE a.payment_id = p_payment_id
               AND r.status = 'posted'
        ), 0)
        - COALESCE((
            SELECT SUM(t.amount)
              FROM public.tenant_credit_transactions AS t
             WHERE t.payment_id = p_payment_id
               AND t.event_type IN ('application', 'reversal')
        ), 0);
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_financial_payment_projection(
    p_payment_id UUID,
    p_effective_on DATE,
    p_payment_method TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_payment public.payments%ROWTYPE;
    v_paid NUMERIC;
    v_paid_date DATE;
    v_payment_method TEXT;
    v_has_financial_entry BOOLEAN;
    v_status TEXT;
BEGIN
    SELECT *
      INTO v_payment
      FROM public.payments
     WHERE id = p_payment_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rent obligation not found.'
            USING ERRCODE = 'P0002';
    END IF;

    v_paid := ROUND(public.financial_payment_paid_amount(p_payment_id), 2);

    SELECT event.effective_on
      INTO v_paid_date
      FROM (
          SELECT r.received_on AS effective_on, a.created_at AS event_at, a.id AS event_id
            FROM public.rent_receipt_allocations AS a
            JOIN public.rent_receipts AS r ON r.id = a.receipt_id
           WHERE a.payment_id = p_payment_id
             AND r.status = 'posted'
             AND a.allocated_amount > COALESCE((
                 SELECT SUM(rv.amount)
                   FROM public.rent_receipt_allocation_reversals AS rv
                  WHERE rv.allocation_id = a.id
             ), 0)
          UNION ALL
          SELECT l.source_paid_date AS effective_on, l.reconciled_at AS event_at, l.id AS event_id
            FROM public.rent_legacy_balances AS l
           WHERE l.payment_id = p_payment_id
             AND l.classification = 'reconciled'
          UNION ALL
          SELECT t.effective_on, t.created_at, t.id
            FROM public.tenant_credit_transactions AS t
           WHERE t.payment_id = p_payment_id
             AND t.event_type IN ('application', 'reversal')
      ) AS event
     ORDER BY event.effective_on DESC, event.event_at DESC, event.event_id DESC
     LIMIT 1;

    SELECT r.payment_method
      INTO v_payment_method
      FROM public.rent_receipt_allocations AS a
      JOIN public.rent_receipts AS r ON r.id = a.receipt_id
     WHERE a.payment_id = p_payment_id
       AND r.status = 'posted'
       AND a.allocated_amount > COALESCE((
           SELECT SUM(rv.amount)
             FROM public.rent_receipt_allocation_reversals AS rv
            WHERE rv.allocation_id = a.id
       ), 0)
     ORDER BY r.received_on DESC, a.created_at DESC, a.id DESC
     LIMIT 1;

    SELECT EXISTS (
        SELECT 1
          FROM public.rent_receipt_allocations AS a
          JOIN public.rent_receipts AS r ON r.id = a.receipt_id
         WHERE a.payment_id = p_payment_id
           AND r.status = 'posted'
           AND a.allocated_amount > COALESCE((
               SELECT SUM(rv.amount)
                 FROM public.rent_receipt_allocation_reversals AS rv
                WHERE rv.allocation_id = a.id
           ), 0)
        UNION ALL
        SELECT 1
          FROM public.tenant_credit_transactions AS t
         WHERE t.payment_id = p_payment_id
           AND t.event_type = 'application'
        UNION ALL
        SELECT 1
          FROM public.rent_legacy_balances AS l
         WHERE l.payment_id = p_payment_id
           AND l.classification = 'reconciled'
    )
      INTO v_has_financial_entry;

    IF v_payment.amount > 0 AND v_paid >= v_payment.amount THEN
        v_status := 'Paid';
    ELSIF v_paid > 0 THEN
        v_status := 'Partially Paid';
    ELSIF v_payment.due_date < (NOW() AT TIME ZONE 'Africa/Mogadishu')::date THEN
        v_status := 'Overdue';
    ELSE
        v_status := 'Outstanding';
    END IF;

    UPDATE public.payments
       SET paid_amount = v_paid,
           paid_date = CASE
               WHEN v_paid > 0 THEN v_paid_date
               ELSE NULL
           END,
           method = v_payment_method,
           status = v_status,
           verification_status = CASE
               WHEN v_paid > 0 AND v_has_financial_entry THEN 'Verified'
               ELSE verification_status
           END,
           verified_at = CASE
               WHEN v_paid > 0 AND v_has_financial_entry
                   THEN COALESCE(verified_at, NOW())
               ELSE verified_at
           END
     WHERE id = p_payment_id;

    RETURN v_paid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_rent_receipt(
    p_tenant_id UUID,
    p_property_id UUID,
    p_lease_id UUID,
    p_amount NUMERIC,
    p_received_on DATE,
    p_payment_method TEXT,
    p_transaction_reference TEXT,
    p_idempotency_key UUID,
    p_recorded_by UUID,
    p_payment_notification_id UUID DEFAULT NULL,
    p_allocations JSONB DEFAULT NULL,
    p_review_note TEXT DEFAULT NULL,
    p_recording_mode TEXT DEFAULT 'Manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_tenant_id UUID := p_tenant_id;
    v_property_id UUID := p_property_id;
    v_lease_id UUID := p_lease_id;
    v_unit_number INTEGER;
    v_notification public.payment_notifications%ROWTYPE;
    v_existing public.rent_receipts%ROWTYPE;
    v_receipt public.rent_receipts%ROWTYPE;
    v_account public.tenant_credit_accounts%ROWTYPE;
    v_payment public.payments%ROWTYPE;
    v_item RECORD;
    v_remaining NUMERIC(12,2);
    v_due NUMERIC(12,2);
    v_apply NUMERIC(12,2);
    v_credit NUMERIC(12,2);
    v_credit_id UUID;
    v_result JSONB;
    v_is_replay BOOLEAN;
    v_response JSONB;
    v_request JSONB;
    v_today DATE := (NOW() AT TIME ZONE 'Africa/Mogadishu')::date;
BEGIN
    PERFORM public.assert_financial_actor(p_recorded_by);

    IF p_amount IS NULL
       OR p_amount::text = 'NaN'
       OR p_amount <= 0
       OR p_amount > 1000000000
       OR p_amount <> ROUND(p_amount, 2) THEN
        RAISE EXCEPTION 'Receipt amount must be positive and valid to two decimal places.'
            USING ERRCODE = '22023';
    END IF;
    IF p_received_on IS NULL OR p_received_on > v_today THEN
        RAISE EXCEPTION 'A confirmed actual receipt date no later than today is required.'
            USING ERRCODE = '22023';
    END IF;
    IF p_payment_method IS NULL OR p_payment_method NOT IN (
        'Cash', 'Bank Transfer', 'Mobile Money', 'Other'
    ) THEN
        RAISE EXCEPTION 'Invalid receipt payment method.'
            USING ERRCODE = '22023';
    END IF;
    IF p_recording_mode IS NULL OR p_recording_mode NOT IN ('Manual', 'Automatic') THEN
        RAISE EXCEPTION 'Invalid receipt recording mode.'
            USING ERRCODE = '22023';
    END IF;
    IF p_transaction_reference IS NOT NULL
       AND LENGTH(p_transaction_reference) > 200 THEN
        RAISE EXCEPTION 'Transaction reference is too long.'
            USING ERRCODE = '22023';
    END IF;

    v_request := jsonb_build_object(
        'tenantId', p_tenant_id,
        'propertyId', p_property_id,
        'leaseId', p_lease_id,
        'amount', p_amount,
        'receivedOn', p_received_on,
        'paymentMethod', p_payment_method,
        'transactionReference', p_transaction_reference,
        'notificationId', p_payment_notification_id,
        'allocations', COALESCE(p_allocations, 'null'::jsonb),
        'reviewNote', p_review_note,
        'recordingMode', p_recording_mode
    );
    SELECT b.is_replay, b.response_payload
      INTO v_is_replay, v_response
      FROM public.begin_financial_operation(
          p_idempotency_key,
          'record_rent_receipt',
          v_request,
          p_recorded_by
      ) AS b;
    IF v_is_replay THEN
        RETURN v_response || jsonb_build_object('duplicate', TRUE);
    END IF;

    IF p_payment_notification_id IS NOT NULL THEN
        SELECT *
          INTO v_notification
          FROM public.payment_notifications
         WHERE id = p_payment_notification_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Payment notification not found.'
                USING ERRCODE = 'P0002';
        END IF;
        IF v_notification.tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR v_notification.lease_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Notification tenant or lease identity is not a valid UUID.'
                USING ERRCODE = '22023';
        END IF;

        v_tenant_id := v_notification.tenant_id::uuid;
        v_lease_id := v_notification.lease_id::uuid;
        IF p_tenant_id IS NOT NULL AND p_tenant_id <> v_tenant_id THEN
            RAISE EXCEPTION 'Notification tenant does not match the receipt tenant.'
                USING ERRCODE = '22023';
        END IF;
        IF p_lease_id IS NOT NULL AND p_lease_id <> v_lease_id THEN
            RAISE EXCEPTION 'Notification lease does not match the receipt lease.'
                USING ERRCODE = '22023';
        END IF;
        IF ROUND(v_notification.amount, 2) <> ROUND(p_amount, 2) THEN
            RAISE EXCEPTION 'Receipt amount must match the verified notification amount.'
                USING ERRCODE = '22023';
        END IF;

        SELECT l.property_id, l.unit_number
          INTO v_property_id, v_unit_number
          FROM public.leases AS l
         WHERE l.id = v_lease_id
           AND l.tenant_id = v_tenant_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Notification lease does not match its tenant.'
                USING ERRCODE = '22023';
        END IF;
        IF p_property_id IS NOT NULL AND p_property_id <> v_property_id THEN
            RAISE EXCEPTION 'Notification property does not match the receipt property.'
                USING ERRCODE = '22023';
        END IF;
        IF v_notification.property_id IS NOT NULL
           AND v_notification.property_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Notification property identity is not a valid UUID.'
                USING ERRCODE = '22023';
        END IF;
        IF v_notification.property_id IS NOT NULL
           AND v_notification.property_id::uuid <> v_property_id THEN
            RAISE EXCEPTION 'Notification property does not match its lease.'
                USING ERRCODE = '22023';
        END IF;
        IF v_notification.unit_number <> v_unit_number THEN
            RAISE EXCEPTION 'Notification unit does not match its lease.'
                USING ERRCODE = '22023';
        END IF;
    ELSIF v_tenant_id IS NULL OR v_property_id IS NULL THEN
        RAISE EXCEPTION 'Tenant and property are required for a manual receipt.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.tenants
         WHERE id = v_tenant_id
           AND property_id = v_property_id
    ) THEN
        RAISE EXCEPTION 'Receipt tenant does not belong to the property.'
            USING ERRCODE = '22023';
    END IF;
    IF v_lease_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM public.leases
         WHERE id = v_lease_id
           AND tenant_id = v_tenant_id
           AND property_id = v_property_id
    ) THEN
        RAISE EXCEPTION 'Receipt lease does not match its tenant and property.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.rent_receipts
     WHERE payment_notification_id = p_payment_notification_id
       AND p_payment_notification_id IS NOT NULL;
    IF FOUND THEN
        IF v_existing.tenant_id = v_tenant_id
           AND v_existing.amount = p_amount
           AND v_existing.received_on = p_received_on
           AND v_existing.payment_method = p_payment_method
           AND COALESCE(v_existing.transaction_reference, '') =
               COALESCE(NULLIF(BTRIM(p_transaction_reference), ''), '')
           AND v_existing.idempotency_key = p_idempotency_key
           AND v_existing.status = 'posted' THEN
            RETURN jsonb_build_object(
                'success', TRUE,
                'duplicate', TRUE,
                'receiptId', v_existing.id
            );
        END IF;
        RAISE EXCEPTION 'This notification already has a different receipt.'
            USING ERRCODE = '23505';
    END IF;
    IF p_payment_notification_id IS NOT NULL
       AND v_notification.status NOT IN (
           'Pending Verification',
           'Verified - Awaiting Rent Recording'
       ) THEN
        RAISE EXCEPTION 'Payment notification is not awaiting receipt recording.'
            USING ERRCODE = '23505';
    END IF;

    -- Locks are acquired as idempotency, notification, account, then
    -- rent obligations in deterministic order.
    INSERT INTO public.tenant_credit_accounts (tenant_id, property_id)
    VALUES (v_tenant_id, v_property_id)
    ON CONFLICT (tenant_id, property_id) DO NOTHING;

    SELECT *
      INTO v_account
      FROM public.tenant_credit_accounts
     WHERE tenant_id = v_tenant_id
       AND property_id = v_property_id
     FOR UPDATE;
    IF v_account.balance <> COALESCE((
        SELECT SUM(amount)
          FROM public.tenant_credit_transactions
         WHERE account_id = v_account.id
    ), 0) THEN
        RAISE EXCEPTION 'Tenant credit account requires reconciliation.'
            USING ERRCODE = '40001';
    END IF;

    IF p_allocations IS NOT NULL
       AND jsonb_typeof(p_allocations) <> 'array' THEN
        RAISE EXCEPTION 'Receipt allocations must be an array.'
            USING ERRCODE = '22023';
    END IF;
    IF p_allocations IS NOT NULL AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_allocations) AS x(value)
         GROUP BY COALESCE(x.value->>'payment_id', x.value->>'paymentId')
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'A rent obligation may appear only once per receipt.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.rent_receipts (
        tenant_id,
        property_id,
        lease_id,
        payment_notification_id,
        amount,
        received_on,
        payment_method,
        transaction_reference,
        source,
        recording_mode,
        idempotency_key,
        recorded_by
    )
    VALUES (
        v_tenant_id,
        v_property_id,
        v_lease_id,
        p_payment_notification_id,
        p_amount,
        p_received_on,
        p_payment_method,
        NULLIF(BTRIM(p_transaction_reference), ''),
        CASE WHEN p_payment_notification_id IS NULL THEN 'manual' ELSE 'notification' END,
        p_recording_mode,
        p_idempotency_key,
        p_recorded_by
    )
    RETURNING * INTO v_receipt;

    v_remaining := p_amount;

    IF p_allocations IS NOT NULL THEN
        FOR v_item IN
            SELECT x.payment_id, x.amount
              FROM jsonb_to_recordset(p_allocations)
                   AS x(payment_id UUID, amount NUMERIC)
             ORDER BY x.payment_id
        LOOP
            IF v_item.amount IS NULL
               OR v_item.amount <= 0
               OR v_item.amount <> ROUND(v_item.amount, 2) THEN
                RAISE EXCEPTION 'Each receipt allocation must be a positive amount to two decimals.'
                    USING ERRCODE = '22023';
            END IF;
            IF v_item.amount > v_remaining THEN
                RAISE EXCEPTION 'Receipt allocations exceed the receipt amount.'
                    USING ERRCODE = '22023';
            END IF;

            SELECT *
              INTO v_payment
              FROM public.payments
             WHERE id = v_item.payment_id
             FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Rent obligation not found.'
                    USING ERRCODE = 'P0002';
            END IF;
            IF v_payment.tenant_id <> v_tenant_id
               OR v_payment.property_id <> v_property_id THEN
                RAISE EXCEPTION 'Receipt allocation obligation does not match the tenant and property.'
                    USING ERRCODE = '22023';
            END IF;
            IF v_lease_id IS NOT NULL
               AND v_payment.lease_id IS NOT NULL
               AND v_payment.lease_id <> v_lease_id THEN
                RAISE EXCEPTION 'Receipt allocation obligation belongs to a different lease.'
                    USING ERRCODE = '22023';
            END IF;

            v_due := ROUND(
                GREATEST(
                    0,
                    v_payment.amount - public.financial_payment_paid_amount(v_payment.id)
                ),
                2
            );
            IF v_item.amount > v_due THEN
                RAISE EXCEPTION 'Receipt allocation exceeds the outstanding rent balance.'
                    USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.rent_receipt_allocations (
                receipt_id, payment_id, allocated_amount, allocated_on, recorded_by
            )
            VALUES (
                v_receipt.id, v_payment.id, v_item.amount, p_received_on, p_recorded_by
            );
            v_remaining := ROUND(v_remaining - v_item.amount, 2);
            PERFORM public.rebuild_financial_payment_projection(
                v_payment.id, p_received_on, p_payment_method
            );
        END LOOP;
    ELSE
        FOR v_payment IN
            SELECT p.*
              FROM public.payments AS p
             WHERE p.tenant_id = v_tenant_id
               AND p.property_id = v_property_id
               AND (v_lease_id IS NULL OR p.lease_id IS NULL OR p.lease_id = v_lease_id)
               AND (v_unit_number IS NULL OR p.unit_number = v_unit_number)
               AND p.amount > public.financial_payment_paid_amount(p.id)
             ORDER BY p.due_date ASC, p.id
             FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;
            v_due := ROUND(
                GREATEST(
                    0,
                    v_payment.amount - public.financial_payment_paid_amount(v_payment.id)
                ),
                2
            );
            v_apply := LEAST(v_remaining, v_due);
            IF v_apply > 0 THEN
                INSERT INTO public.rent_receipt_allocations (
                    receipt_id, payment_id, allocated_amount, allocated_on, recorded_by
                )
                VALUES (
                    v_receipt.id, v_payment.id, v_apply, p_received_on, p_recorded_by
                );
                v_remaining := ROUND(v_remaining - v_apply, 2);
                PERFORM public.rebuild_financial_payment_projection(
                    v_payment.id, p_received_on, p_payment_method
                );
            END IF;
        END LOOP;
    END IF;

    v_credit := v_remaining;
    IF v_credit > 0 THEN
        INSERT INTO public.tenant_credit_transactions (
            account_id,
            event_type,
            amount,
            effective_on,
            source_receipt_id,
            idempotency_key,
            recorded_by,
            reason
        )
        VALUES (
            v_account.id,
            'issued',
            v_credit,
            p_received_on,
            v_receipt.id,
            p_idempotency_key,
            p_recorded_by,
            'Unallocated receipt amount'
        )
        RETURNING id INTO v_credit_id;

        UPDATE public.tenant_credit_accounts
           SET balance = balance + v_credit,
               updated_at = NOW()
         WHERE id = v_account.id;
    END IF;

    IF p_payment_notification_id IS NOT NULL THEN
        UPDATE public.payment_notifications
           SET status = 'Verified - Rent Recorded',
               recording_mode = p_recording_mode,
               recorded_at = NOW(),
               recorded_by = p_recorded_by::text,
               recording_note = p_review_note,
               reviewed_at = COALESCE(reviewed_at, NOW()),
               reviewed_by = COALESCE(reviewed_by, p_recorded_by::text),
               review_note = COALESCE(p_review_note, review_note)
         WHERE id = p_payment_notification_id;
    END IF;

    INSERT INTO public.financial_audit_logs (
        entity_type, entity_id, action, actor_id, reason, details
    )
    VALUES (
        'rent_receipt',
        v_receipt.id,
        'posted',
        p_recorded_by,
        p_review_note,
        jsonb_build_object(
            'amount', p_amount,
            'receivedOn', p_received_on,
            'tenantId', v_tenant_id,
            'propertyId', v_property_id,
            'notificationId', p_payment_notification_id,
            'creditIssued', v_credit,
            'creditTransactionId', v_credit_id
        )
    );

    v_result := jsonb_build_object(
        'success', TRUE,
        'duplicate', FALSE,
        'receiptId', v_receipt.id,
        'amount', p_amount,
        'allocatedAmount', ROUND(p_amount - v_remaining, 2),
        'creditIssued', v_credit,
        'creditTransactionId', v_credit_id
    );
    UPDATE public.financial_idempotency_records
       SET response_payload = v_result
     WHERE idempotency_key = p_idempotency_key;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_financial_actor(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_financial_operation(UUID, TEXT, JSONB, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_rent_legacy_balance(UUID, DATE, TEXT, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.financial_payment_paid_amount(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_financial_payment_projection(UUID, DATE, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_financial_expense_category(TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_rent_receipt(
    UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, UUID, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_tenant_credit(
    UUID, UUID, UUID, NUMERIC, DATE, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_tenant_credit(
    UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_rent_receipt(UUID, DATE, TEXT, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_financial_expense(
    UUID, UUID, NUMERIC, TEXT, DATE, DATE, TEXT, TEXT, TEXT, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_financial_expense(UUID, TEXT, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.financial_month_summary(DATE)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.financial_month_summary_at(DATE, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_financial_month_snapshot(DATE, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_financial_month_snapshot(UUID, BOOLEAN, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_payment_notification(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_financial_expense_category(TEXT, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.record_rent_receipt(
    UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, UUID, JSONB, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_tenant_credit(
    UUID, UUID, UUID, NUMERIC, DATE, UUID, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_tenant_credit(
    UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_rent_receipt(UUID, DATE, TEXT, UUID, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.create_financial_expense(
    UUID, UUID, NUMERIC, TEXT, DATE, DATE, TEXT, TEXT, TEXT, UUID, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_rent_legacy_balance(UUID, DATE, TEXT, UUID, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.void_financial_expense(UUID, TEXT, UUID, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.financial_month_summary(DATE)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_financial_month_snapshot(DATE, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_financial_month_snapshot(UUID, BOOLEAN, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.review_payment_notification(UUID, TEXT, TEXT, TEXT)
    TO service_role;

COMMIT;
