-- Keep the review RPC compatible with databases where payments.verified_by
-- is UUID as well as databases created from the earlier TEXT migration.
-- Apply after 20261021_payment_notification_review_modes.sql.
-- Review only: do not execute without confirming the live schema and approval.

BEGIN;

CREATE OR REPLACE FUNCTION public.review_payment_notification(
    p_notification_id uuid,
    p_action text,
    p_reviewed_by text DEFAULT NULL,
    p_review_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_notification public.payment_notifications%ROWTYPE;
    v_payment RECORD;
    v_remaining numeric(12,2);
    v_due numeric(12,2);
    v_apply numeric(12,2);
    v_paid numeric(12,2);
    v_status text;
    v_verified_by_type oid;
    v_verified_by_is_uuid boolean;
    v_reviewed_by_uuid uuid;
BEGIN
    SELECT a.atttypid
      INTO v_verified_by_type
      FROM pg_attribute AS a
     WHERE a.attrelid = 'public.payments'::regclass
       AND a.attname = 'verified_by'
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_verified_by_type IS NULL OR v_verified_by_type NOT IN (
        'uuid'::regtype,
        'text'::regtype
    ) THEN
        RAISE EXCEPTION 'payments.verified_by must exist and use UUID or TEXT.';
    END IF;

    v_verified_by_is_uuid := v_verified_by_type = 'uuid'::regtype;

    IF p_action IS NULL OR p_action NOT IN (
        'VerifiedManual',
        'VerifiedAuto',
        'MarkManuallyRecorded',
        'Rejected'
    ) THEN
        RAISE EXCEPTION 'Invalid payment notification review action.';
    END IF;

    IF p_action = 'VerifiedAuto' AND v_verified_by_is_uuid THEN
        IF p_reviewed_by IS NULL OR btrim(p_reviewed_by) = '' THEN
            RAISE EXCEPTION 'A valid reviewer UUID is required for automatic payment verification.';
        END IF;

        v_reviewed_by_uuid := btrim(p_reviewed_by)::uuid;
    END IF;

    SELECT *
      INTO v_notification
      FROM public.payment_notifications
     WHERE id = p_notification_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment notification not found.';
    END IF;

    IF p_action = 'MarkManuallyRecorded' THEN
        IF v_notification.status <> 'Verified - Awaiting Rent Recording' THEN
            RAISE EXCEPTION 'Notification is not awaiting rent recording.';
        END IF;

        UPDATE public.payment_notifications
           SET status = 'Verified - Rent Recorded',
               recording_mode = 'Manual',
               recorded_at = now(),
               recorded_by = p_reviewed_by,
               recording_note = p_review_note
         WHERE id = p_notification_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'Verified - Rent Recorded',
            'recordingMode', 'Manual',
            'notificationId', p_notification_id
        );
    END IF;

    IF v_notification.status <> 'Pending Verification' THEN
        RAISE EXCEPTION 'This notification has already been reviewed.';
    END IF;

    IF p_action = 'Rejected' THEN
        UPDATE public.payment_notifications
           SET status = 'Rejected',
               reviewed_at = now(),
               reviewed_by = p_reviewed_by,
               review_note = p_review_note
         WHERE id = p_notification_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'Rejected',
            'notificationId', p_notification_id
        );
    END IF;

    IF p_action = 'VerifiedManual' THEN
        UPDATE public.payment_notifications
           SET status = 'Verified - Awaiting Rent Recording',
               recording_mode = 'Manual',
               reviewed_at = now(),
               reviewed_by = p_reviewed_by,
               review_note = p_review_note
         WHERE id = p_notification_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'Verified - Awaiting Rent Recording',
            'recordingMode', 'Manual',
            'notificationId', p_notification_id
        );
    END IF;

    v_remaining := ROUND(v_notification.amount, 2);

    FOR v_payment IN
        SELECT p.id, p.amount, p.paid_amount, p.due_date
          FROM public.payments AS p
         WHERE p.lease_id IS NOT NULL
           AND p.lease_id::text = v_notification.lease_id
           AND p.tenant_id::text = v_notification.tenant_id
           AND p.unit_number = v_notification.unit_number
           AND (
               v_notification.property_id IS NULL
               OR p.property_id::text = v_notification.property_id
           )
           AND COALESCE(p.paid_amount, 0) < p.amount
         ORDER BY p.due_date ASC NULLS LAST, p.id
         FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        v_due := ROUND(
            GREATEST(0, v_payment.amount - COALESCE(v_payment.paid_amount, 0)),
            2
        );
        v_apply := LEAST(v_remaining, v_due);
        v_paid := ROUND(COALESCE(v_payment.paid_amount, 0) + v_apply, 2);

        IF v_paid >= v_payment.amount THEN
            v_status := 'Paid';
        ELSIF v_paid > 0 THEN
            v_status := 'Partially Paid';
        ELSIF v_payment.due_date < CURRENT_DATE THEN
            v_status := 'Overdue';
        ELSE
            v_status := 'Outstanding';
        END IF;

        IF v_verified_by_is_uuid THEN
            UPDATE public.payments
               SET paid_amount = v_paid,
                   paid_date = CURRENT_DATE,
                   method = v_notification.payment_method,
                   status = v_status,
                   verification_status = 'Verified',
                   verified_at = now(),
                   verified_by = v_reviewed_by_uuid
             WHERE id = v_payment.id;
        ELSE
            UPDATE public.payments
               SET paid_amount = v_paid,
                   paid_date = CURRENT_DATE,
                   method = v_notification.payment_method,
                   status = v_status,
                   verification_status = 'Verified',
                   verified_at = now(),
                   verified_by = p_reviewed_by
             WHERE id = v_payment.id;
        END IF;

        v_remaining := ROUND(v_remaining - v_apply, 2);
    END LOOP;

    IF v_remaining > 0 THEN
        RAISE EXCEPTION
            'Insufficient outstanding rent balance. Unapplied amount: %',
            v_remaining;
    END IF;

    UPDATE public.payment_notifications
       SET status = 'Verified - Rent Recorded',
           recording_mode = 'Automatic',
           recorded_at = now(),
           recorded_by = p_reviewed_by,
           reviewed_at = now(),
           reviewed_by = p_reviewed_by,
           review_note = p_review_note
     WHERE id = p_notification_id;

    RETURN jsonb_build_object(
        'success', true,
        'status', 'Verified - Rent Recorded',
        'recordingMode', 'Automatic',
        'notificationId', p_notification_id,
        'amountApplied', v_notification.amount
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.review_payment_notification(uuid, text, text, text)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_payment_notification(uuid, text, text, text)
    TO service_role;

COMMIT;
