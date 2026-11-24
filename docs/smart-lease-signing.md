# Smart Lease Signing

## Signing flow

1. A manager opens the lease's existing **Documents** panel and starts or continues Smart Lease Signing.
2. The tenant opens the unit QR portal, verifies the tenant PIN, and chooses **Review & Sign Lease**.
3. The tenant reviews the lease terms and writes a fresh handwritten signature using a finger, stylus, or mouse in the on-screen signing area. The API accepts the signature only from that lease's active PIN-verified tenant QR session. Uploading a signature image and reusing a previously stored signature are not supported.
4. After the tenant signature is saved, the manager refreshes signing status and signs from the authenticated manager account.
5. The API generates an A4 PDF, records its SHA-256 digest, and stores it in the existing private `lease-documents` bucket and `lease_documents` table as `document_type = 'signed_lease'`.
6. The signed PDF includes each signer's independent server timestamp and the existing lease-document QR link. The tenant QR archive lists the generated signed lease separately from manually uploaded supporting documents. The drawn or extracted signature PNG is a temporary private-storage artifact used while the PDF is generated; after the signed PDF is safely archived, that PNG is deleted. When the photo method is used, the original source photograph is retained in the private bucket for manager review through a short-lived signed URL. The signing audit event records hashes for both source and extracted images. This establishes that the extracted image came from the uploaded photo, but it does not verify the person's identity or prove who physically wrote the signature. The signed PDF remains the retained signature record.

The same QR link continues to resolve to the current document list, so later manual uploads remain visible without reprinting the QR. The manager's lease Documents panel also provides Share QR / link, Copy link, and Download QR controls for the unit's PIN-protected tenant portal.

## Database migrations

Apply migrations in order:

1. `backend/migrations/202611070002_lease_documents.sql` — creates the existing private document archive and lease-specific QR access.
2. `backend/migrations/202611240001_smart_lease_signing.sql` — adds document classification, signing sessions, and signing audit events.
The historical `202611240002_tenant_signature_photo_evidence.sql` migration belongs to the optional photo-upload experiment and is not required for manual-only signing. Do not apply it as part of this feature. If it was applied in another environment, its nullable column is left untouched for data preservation; the application no longer reads or writes it.

The signing migration is committed for review only. Do not apply migrations to production as part of this change.

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
- Verify the tenant can sign only by drawing a fresh signature with touch, stylus, or mouse; image upload and reusable saved signatures are unavailable.
- Verify the final signed PDF retains both signatures after temporary PNG cleanup.
- Verify the manager can share, copy, and download the correct unit QR code, including Unit 302 → `/qr/302`.
- Verify tenant and manager dates differ correctly when they sign on different days.
- Verify the final PDF appears in the existing manager Documents list and public QR archive, alongside manual uploads.
- Verify a lease edit after the first signature requires a fresh signing session while preserving the prior signing record and any previously generated PDF.
- Verify PDF generation can be retried after a temporary Storage/database failure without replacing an already uploaded signed PDF.
