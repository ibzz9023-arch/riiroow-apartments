-- Link rent records to the exact lease without guessing historical associations.
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS lease_id uuid
    REFERENCES public.leases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payments_lease_id_due_date_idx
    ON public.payments (lease_id, due_date);
-- Riiroow QR payment notifications
-- REVIEW ONLY: Do not execute against production without explicit approval.
-- Tenant notifications are separate from confirmed rent payments.
-- This migration does not alter existing payments or security deposits.

CREATE TABLE public.payment_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id text NOT NULL,
    tenant_id text NOT NULL,
    unit_id text NOT NULL,
    property_id text,
    unit_number integer NOT NULL,
    amount numeric(12,2) NOT NULL CHECK (amount > 0),
    payment_method text NOT NULL,
    transaction_reference text,
    status text NOT NULL DEFAULT 'Pending Verification'
        CHECK (status IN ('Pending Verification', 'Verified', 'Rejected')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by text,
    review_note text
);

CREATE INDEX payment_notifications_status_submitted_idx
    ON public.payment_notifications (status, submitted_at DESC);

CREATE INDEX payment_notifications_lease_submitted_idx
    ON public.payment_notifications (lease_id, submitted_at DESC);

-- Access is intended through the backend using its trusted Supabase
-- service-role client. No public or anonymous table policies are added.
ALTER TABLE public.payment_notifications ENABLE ROW LEVEL SECURITY;

-- Atomic manager review for QR payment notifications.
-- LOCAL REVIEW ONLY: Do not execute against production without approval.
-- Verification and rent-ledger updates occur in one database transaction.

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
BEGIN
    IF p_action NOT IN ('Verified', 'Rejected') THEN
        RAISE EXCEPTION 'Action must be Verified or Rejected.';
    END IF;

    SELECT *
      INTO v_notification
      FROM public.payment_notifications
     WHERE id = p_notification_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment notification not found.';
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

    v_remaining := ROUND(v_notification.amount, 2);

    -- Lock matching rent rows in oldest-due-first order.
    -- Notifications never create new rent charges.
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

        UPDATE public.payments
           SET paid_amount = v_paid,
               paid_date = CURRENT_DATE,
               method = v_notification.payment_method,
               status = v_status
         WHERE id = v_payment.id;

        v_remaining := ROUND(v_remaining - v_apply, 2);
    END LOOP;

    IF v_remaining > 0 THEN
        RAISE EXCEPTION
            'Insufficient outstanding rent balance. Unapplied amount: %',
            v_remaining;
    END IF;

    UPDATE public.payment_notifications
       SET status = 'Verified',
           reviewed_at = now(),
           reviewed_by = p_reviewed_by,
           review_note = p_review_note
     WHERE id = p_notification_id;

    RETURN jsonb_build_object(
        'success', true,
        'status', 'Verified',
        'notificationId', p_notification_id,
        'amountApplied', v_notification.amount
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.review_payment_notification(uuid, text, text, text)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_payment_notification(uuid, text, text, text)
    TO service_role;
