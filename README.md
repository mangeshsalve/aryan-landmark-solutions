# Aryan Landmark Solutions — Final Architecture Package

This package contains the final database/API architecture for the greenfield
production application.

## Final PostgreSQL tables

- users
- properties
- attachments
- inquiries
- inquiry_assignments
- audit_logs

## Important change

`inquiry_attachment` and `inquiry_recordings` were consolidated into:

`attachments`

The `attachments.attachment_type` values are:

- PHOTO
- DOCUMENT
- RECORDING

The `attachments.file_size_bytes` column stores the file size in bytes.

## Storage

Cloudflare R2.

No Cloudinary.
No local production file storage.
No binary file storage in PostgreSQL.

## Authoritative documents

- docs/database/database-design.md
- docs/database/schema.sql
- docs/database/erd.mmd
- docs/api/openapi.yaml
- docs/api/api-conventions.md
- docs/architecture/greenfield-implementation-plan.md

`prisma/schema.prisma` will become the executable schema source of truth when
the backend implementation starts.
