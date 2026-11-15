# Riiroow Apartment Management - Backend

This folder contains the backend system for the Riiroow Apartment Property Management System.

## Main Components

- User authentication
- Property management
- Apartment management
- Tenant management
- Lease management
- Payment management
- Expense management
- Maintenance management
- Financial reporting
- Audit logging

## Financial management integration

Managers and Admins use the Financial Management dashboard to record expenses, rent receipts, credit applications/refunds, reconciliations, and monthly snapshots. Accountants have authorized read-only access. The dashboard requires a Manager/Admin to confirm the actual receipt date and payment method before recording a tenant payment notification through `POST /api/financial/receipts/notifications/:notificationId`. The notification review endpoint remains available for rejection only; its legacy positive actions fail closed.

Receipt requests must include an explicit `receivedOn` (`YYYY-MM-DD`), confirmed payment method, and UUID `Idempotency-Key` reused for retries. Never derive receipt dates from submission, review, or server timestamps. Explicit rent allocations use an `allocations` array of `{ paymentId, amount }`; when omitted, the database allocates oldest-due rent first and holds any overpayment as tenant credit. Receipt posting, credit issuance, payment projection updates, and notification completion occur in one database transaction.

Expense entries require separate `expenseOn` and, when paid, `paidOn` dates. Monthly expense management filters by expense date so unpaid entries remain visible; only paid expenses reduce monthly profit. Legacy rent balances remain excluded from monthly cash and recognized income until an authorized Manager/Admin confirms a source receipt date and records reliable supporting evidence through the reconciliation endpoint.
