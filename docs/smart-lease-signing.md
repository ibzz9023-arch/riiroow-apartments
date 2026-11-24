# Smart Lease Signing

## Signing flow

1. A manager opens the lease's existing **Documents** panel and starts or continues Smart Lease Signing.
2. The tenant opens the unit QR portal, verifies the tenant PIN, and chooses **Review & Sign Lease**.
3. The tenant reviews the lease terms and writes a signature using Apple Pencil or finger input. The API accepts this only from that lease's active PIN-verified tenant QR session.
4. After the tenant signature is saved, the manager refreshes signing status and signs from the authenticated manager account.
5. The API generates an A4 PDF, records its SHA-256 digest, and stores it in the existing private `lease-documents` bucket and `lease_documents` table as `document_type = 'signed_lease'`.
6. The signed PDF includes each signer's independent server timestamp. The existing QR code printed at the end of the lease continues to open the same tenant document archive, where the generated signed lease is listed separately from manually uploaded supporting documents.

The same QR link continues to resolve to the current document list, so later manual uploads remain visible without reprinting the QR.

## Database migrations

Apply migrations in order:

1. `backend/migrations/202611070002_lease_documents.sql` — creates the existing private document archive and lease-specific QR access.
2. `backend/migrations/202611240001_smart_lease_signing.sql` — adds document classification, signing sessions, and signing audit events.

These migration files are committed for review only. They are not applied to the live Supabase database by this feature branch.

## Runtime configuration

- The `lease-documents` Storage bucket must remain private.
- The existing lease-document token secret must remain unchanged for already printed QR codes. If the application uses `SESSION_SECRET` as its fallback, keep that secret stable.
- `PUBLIC_APP_URL` may be set to the public Railway application origin. If omitted, the API uses the request origin when generating the QR embedded in the PDF.
- Backend installation uses the repository's existing `npm --prefix backend install` build step; PDFKit and QRCode are added as backend dependencies.

## Review checklist

- Apply the two migrations to a non-production Supabase environment first.
- Verify a tenant can load the signing step only after PIN verification for the matching active unit.
- Verify a manager session cannot submit a tenant signature and a tenant QR session cannot submit a manager signature.
- Verify the manager cannot sign before the tenant.
- Verify tenant and manager dates differ correctly when they sign on different days.
- Verify the final PDF appears in the existing manager Documents list and public QR archive, alongside manual uploads.
- Verify a lease edit after the first signature requires a fresh signing session while preserving the prior signing record and any previously generated PDF.
- Verify PDF generation can be retried after a temporary Storage/database failure without replacing an already uploaded signed PDF.
