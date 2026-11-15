-- Additive financial-management schema.
-- Do not apply until the live schema has been reconciled and production change
-- approval has been granted.

BEGIN;

CREATE TABLE IF NOT EXISTS public.financial_expense_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_expense_categories_name_uq
    ON public.financial_expense_categories (LOWER(name));

INSERT INTO public.financial_expense_categories (name)
VALUES
    ('Maintenance'),
    ('Utilities'),
    ('Payroll'),
    ('Taxes and fees'),
    ('Insurance'),
    ('Supplies'),
    ('Other')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rent_legacy_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT,
    property_id UUID REFERENCES public.properties(id) ON DELETE RESTRICT,
    legacy_amount NUMERIC NOT NULL CHECK (legacy_amount > 0),
    source_paid_date DATE,
    verification_status TEXT,
    classification TEXT NOT NULL CHECK (
        classification IN ('undated', 'excluded_unverified', 'reconciled')
    ),
    evidence_note TEXT,
    reconciled_at TIMESTAMPTZ,
    reconciled_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS rent_legacy_balances_payment_uq
    ON public.rent_legacy_balances (payment_id);

-- Preserve aggregate paid amounts as undated legacy balances. Explicitly
-- pending/rejected values are retained for reconciliation but are not treated
-- as settled rent or income. No historical receipt dates are inferred.
INSERT INTO public.rent_legacy_balances (
    payment_id,
    tenant_id,
    property_id,
    legacy_amount,
    source_paid_date,
    verification_status,
    classification
)
SELECT
    p.id,
    p.tenant_id,
    p.property_id,
    p.paid_amount,
    p.paid_date,
    p.verification_status,
    CASE
        WHEN LOWER(COALESCE(p.verification_status, '')) IN (
            'pending verification',
            'rejected'
        ) THEN 'excluded_unverified'
        ELSE 'undated'
    END
FROM public.payments AS p
WHERE COALESCE(p.paid_amount, 0) > 0
ON CONFLICT (payment_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rent_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
    lease_id UUID REFERENCES public.leases(id) ON DELETE RESTRICT,
    payment_notification_id UUID UNIQUE
        REFERENCES public.payment_notifications(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    received_on DATE NOT NULL,
    payment_method TEXT NOT NULL CHECK (
        payment_method IN ('Cash', 'Bank Transfer', 'Mobile Money', 'Other')
    ),
    transaction_reference TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual', 'notification')),
    recording_mode TEXT NOT NULL CHECK (recording_mode IN ('Manual', 'Automatic')),
    idempotency_key UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,
    void_idempotency_key UUID UNIQUE,
    CHECK (
        (source = 'notification' AND payment_notification_id IS NOT NULL)
        OR (source = 'manual' AND payment_notification_id IS NULL)
    ),
    CHECK (
        (status = 'posted' AND voided_at IS NULL AND void_reason IS NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rent_receipts_property_idempotency_uq
    ON public.rent_receipts (property_id, idempotency_key);

CREATE INDEX IF NOT EXISTS rent_receipts_property_received_idx
    ON public.rent_receipts (property_id, received_on DESC);

CREATE INDEX IF NOT EXISTS rent_receipts_tenant_received_idx
    ON public.rent_receipts (tenant_id, received_on DESC);

CREATE TABLE IF NOT EXISTS public.rent_receipt_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES public.rent_receipts(id) ON DELETE RESTRICT,
    payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
    allocated_amount NUMERIC(12,2) NOT NULL CHECK (allocated_amount > 0),
    allocated_on DATE NOT NULL,
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (receipt_id, payment_id)
);

CREATE INDEX IF NOT EXISTS rent_receipt_allocations_payment_idx
    ON public.rent_receipt_allocations (payment_id, allocated_on);

CREATE TABLE IF NOT EXISTS public.rent_receipt_allocation_reversals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_id UUID NOT NULL
        REFERENCES public.rent_receipt_allocations(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reversed_on DATE NOT NULL,
    idempotency_key UUID NOT NULL,
    reason TEXT NOT NULL,
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (allocation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS rent_receipt_allocation_reversals_date_idx
    ON public.rent_receipt_allocation_reversals (reversed_on);

CREATE TABLE IF NOT EXISTS public.tenant_credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, property_id)
);

CREATE TABLE IF NOT EXISTS public.tenant_credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL
        REFERENCES public.tenant_credit_accounts(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (
        event_type IN ('issued', 'application', 'refund', 'reversal')
    ),
    amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    effective_on DATE NOT NULL,
    source_receipt_id UUID
        REFERENCES public.rent_receipts(id) ON DELETE RESTRICT,
    credit_source_transaction_id UUID
        REFERENCES public.tenant_credit_transactions(id) ON DELETE RESTRICT,
    payment_id UUID REFERENCES public.payments(id) ON DELETE RESTRICT,
    reverses_transaction_id UUID UNIQUE
        REFERENCES public.tenant_credit_transactions(id) ON DELETE RESTRICT,
    idempotency_key UUID NOT NULL,
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (event_type = 'issued'
            AND amount > 0
            AND source_receipt_id IS NOT NULL
            AND credit_source_transaction_id IS NULL
            AND payment_id IS NULL
            AND reverses_transaction_id IS NULL)
        OR (event_type = 'application'
            AND amount < 0
            AND source_receipt_id IS NULL
            AND credit_source_transaction_id IS NOT NULL
            AND payment_id IS NOT NULL
            AND reverses_transaction_id IS NULL)
        OR (event_type = 'refund'
            AND amount < 0
            AND source_receipt_id IS NULL
            AND credit_source_transaction_id IS NOT NULL
            AND payment_id IS NULL
            AND reverses_transaction_id IS NULL)
        OR (event_type = 'reversal'
            AND source_receipt_id IS NULL
            AND credit_source_transaction_id IS NOT NULL
            AND reverses_transaction_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_credit_issue_receipt_uq
    ON public.tenant_credit_transactions (source_receipt_id)
    WHERE event_type = 'issued';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_credit_transactions_idempotency_uq
    ON public.tenant_credit_transactions (
        account_id,
        idempotency_key,
        event_type,
        credit_source_transaction_id,
        payment_id
    );

CREATE INDEX IF NOT EXISTS tenant_credit_transactions_account_date_idx
    ON public.tenant_credit_transactions (account_id, effective_on, created_at);

CREATE INDEX IF NOT EXISTS tenant_credit_transactions_source_idx
    ON public.tenant_credit_transactions (credit_source_transaction_id);

CREATE TABLE IF NOT EXISTS public.rent_cash_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_transaction_id UUID NOT NULL UNIQUE
        REFERENCES public.tenant_credit_transactions(id) ON DELETE RESTRICT,
    credit_source_transaction_id UUID NOT NULL
        REFERENCES public.tenant_credit_transactions(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    refunded_on DATE NOT NULL,
    payment_method TEXT NOT NULL CHECK (
        payment_method IN ('Cash', 'Bank Transfer', 'Mobile Money', 'Other')
    ),
    transaction_reference TEXT,
    idempotency_key UUID NOT NULL UNIQUE,
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rent_cash_refunds_date_idx
    ON public.rent_cash_refunds (refunded_on);

CREATE TABLE IF NOT EXISTS public.financial_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
    category_id UUID NOT NULL
        REFERENCES public.financial_expense_categories(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    description TEXT NOT NULL,
    expense_on DATE NOT NULL,
    payment_method TEXT CHECK (
        payment_method IS NULL
        OR payment_method IN ('Cash', 'Bank Transfer', 'Mobile Money', 'Other')
    ),
    transaction_reference TEXT,
    paid_on DATE,
    status TEXT NOT NULL DEFAULT 'paid' CHECK (
        status IN ('unpaid', 'paid', 'voided')
    ),
    receipt_storage_path TEXT,
    idempotency_key UUID NOT NULL,
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,
    CHECK (
        (status = 'unpaid' AND paid_on IS NULL AND voided_at IS NULL)
        OR (status = 'paid' AND paid_on IS NOT NULL AND voided_at IS NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
    )
);

ALTER TABLE public.financial_expenses
    ADD COLUMN IF NOT EXISTS expense_on DATE;

DO $block$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.financial_expenses
         WHERE expense_on IS NULL
    ) THEN
        RAISE EXCEPTION
            'Existing expenses require an explicitly reconciled expense date before this migration can continue.';
    END IF;
END;
$block$;

ALTER TABLE public.financial_expenses
    ALTER COLUMN expense_on SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS financial_expenses_property_idempotency_uq
    ON public.financial_expenses (property_id, idempotency_key);

CREATE INDEX IF NOT EXISTS financial_expenses_paid_date_idx
    ON public.financial_expenses (property_id, paid_on, category_id)
    WHERE status = 'paid';

CREATE INDEX IF NOT EXISTS financial_expenses_expense_date_idx
    ON public.financial_expenses (property_id, expense_on, category_id);

CREATE TABLE IF NOT EXISTS public.financial_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    entity_id UUID,
    action TEXT NOT NULL,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reason TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS financial_audit_logs_entity_idx
    ON public.financial_audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS financial_audit_logs_actor_idx
    ON public.financial_audit_logs (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.financial_idempotency_records (
    idempotency_key UUID PRIMARY KEY,
    operation_type TEXT NOT NULL,
    request_payload JSONB NOT NULL,
    response_payload JSONB,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.financial_monthly_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start DATE NOT NULL UNIQUE,
    current_finalized_version_id UUID,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period_start = DATE_TRUNC('month', period_start)::date)
);

CREATE TABLE IF NOT EXISTS public.financial_monthly_snapshot_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL
        REFERENCES public.financial_monthly_snapshots(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    supersedes_version_id UUID
        REFERENCES public.financial_monthly_snapshot_versions(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'finalized')
    ),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    reporting_timezone TEXT NOT NULL DEFAULT 'Africa/Mogadishu'
        CHECK (reporting_timezone = 'Africa/Mogadishu'),
    cash_collected NUMERIC(14,2) NOT NULL DEFAULT 0,
    cash_refunded NUMERIC(14,2) NOT NULL DEFAULT 0,
    rent_income_recognized NUMERIC(14,2) NOT NULL DEFAULT 0,
    paid_expenses NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
    tenant_credit_liability NUMERIC(14,2) NOT NULL DEFAULT 0,
    undated_legacy_balances NUMERIC(14,2) NOT NULL DEFAULT 0,
    excluded_unverified_balances NUMERIC(14,2) NOT NULL DEFAULT 0,
    expense_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    completeness_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_complete BOOLEAN NOT NULL DEFAULT FALSE,
    incomplete_acknowledged_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    incomplete_acknowledged_at TIMESTAMPTZ,
    source_cutoff TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    calculation_version TEXT NOT NULL DEFAULT '1',
    prepared_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (snapshot_id, version_number),
    CHECK (
        (status = 'draft' AND finalized_at IS NULL)
        OR (status = 'finalized' AND finalized_at IS NOT NULL)
    ),
    CHECK (
        status <> 'finalized'
        OR is_complete
        OR (
            incomplete_acknowledged_by IS NOT NULL
            AND incomplete_acknowledged_at IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS financial_snapshot_versions_period_idx
    ON public.financial_monthly_snapshot_versions (snapshot_id, version_number DESC);

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'financial_monthly_snapshots_current_version_fk'
           AND conrelid = 'public.financial_monthly_snapshots'::regclass
    ) THEN
        ALTER TABLE public.financial_monthly_snapshots
            ADD CONSTRAINT financial_monthly_snapshots_current_version_fk
            FOREIGN KEY (current_finalized_version_id)
            REFERENCES public.financial_monthly_snapshot_versions(id)
            ON DELETE RESTRICT;
    END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION public.prevent_finalized_financial_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'finalized' THEN
            RAISE EXCEPTION 'Finalized financial snapshots are immutable.';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'finalized' THEN
        RAISE EXCEPTION 'Finalized financial snapshots are immutable.';
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS financial_snapshot_version_immutable
    ON public.financial_monthly_snapshot_versions;

CREATE TRIGGER financial_snapshot_version_immutable
BEFORE UPDATE OR DELETE ON public.financial_monthly_snapshot_versions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_finalized_financial_snapshot_mutation();

DO $block$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'financial_expense_categories',
        'rent_legacy_balances',
        'rent_receipts',
        'rent_receipt_allocations',
        'rent_receipt_allocation_reversals',
        'tenant_credit_accounts',
        'tenant_credit_transactions',
        'rent_cash_refunds',
        'financial_expenses',
        'financial_audit_logs',
        'financial_idempotency_records',
        'financial_monthly_snapshots',
        'financial_monthly_snapshot_versions'
    ]
    LOOP
        EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE FORMAT(
            'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
            v_table
        );
        EXECUTE FORMAT('REVOKE ALL ON TABLE public.%I FROM service_role', v_table);
        EXECUTE FORMAT('GRANT SELECT ON TABLE public.%I TO service_role', v_table);
        EXECUTE FORMAT(
            'DROP POLICY IF EXISTS financial_service_role_read ON public.%I',
            v_table
        );
        EXECUTE FORMAT(
            'CREATE POLICY financial_service_role_read ON public.%I FOR SELECT TO service_role USING (true)',
            v_table
        );
    END LOOP;
END;
$block$;

COMMIT;
