# Final Greenfield Implementation Plan

This is a new production application. Do not reuse the old MVP/Spring Boot/
Flutter implementation.

## Stack
- Node.js
- TypeScript
- NestJS
- Prisma
- PostgreSQL
- Cloudflare R2
- Flutter
- Riverpod
- Dio

## Final database

Exactly six tables:

1. users
2. properties
3. attachments
4. inquiries
5. inquiry_assignments
6. audit_logs

### Attachment consolidation

The old `inquiry_attachment` and `inquiry_recordings` tables are removed.

`attachments` handles:
- PHOTO
- DOCUMENT
- RECORDING

One inquiry can therefore have multiple RECORDING attachments.

## Attachment storage

Cloudflare R2 stores binary files.
PostgreSQL stores:
- attachment type
- document type
- file name
- MIME type
- file size in bytes
- R2 bucket
- R2 object key
- optional URL
- resource relationship
- uploader
- timestamps

## Inquiry recording rule

ADMIN-created inquiry:
- at least one RECORDING attachment required.

EMPLOYEE-created inquiry:
- RECORDING attachment optional.

Role is derived from JWT.

## Assignment

`handled_by_user_id` identifies the employee handling the inquiry.

`assigned_to_user_id` identifies the current employee assignment.

`inquiry_assignments` stores history.

Reassignment must update the inquiry and insert history in one transaction.

## Cloudflare upload flow

1. Authenticate.
2. Request upload authorization.
3. Validate resource and file metadata.
4. Generate short-lived R2 upload authorization.
5. Upload directly to R2.
6. Finalize through backend.
7. Verify object.
8. Save attachment metadata.
9. Audit the operation.

## Implementation phases

1. Backend foundation
2. Prisma schema and migrations
3. Authentication/authorization
4. Master management
5. Users/customers
6. Properties
7. Unified attachment/R2 module
8. Inquiry
9. Assignment/history
10. Public property API
11. Reports after requirements are finalized
12. New Flutter application
13. Integration testing
14. Security testing
15. CI/CD and deployment

Claude Code must implement one phase at a time and stop after each phase for
review. Never ask Claude Code to implement the complete application in one
prompt.
