# API Conventions — Aryan Landmark Solutions

Base path: `/api/v1`

## Authentication

Application APIs:
`Authorization: Bearer <application JWT>`

Master APIs:
`Authorization: Bearer <master JWT>`

The backend derives authenticated identity and role from the validated token.
Request bodies must never be trusted for authorization.

## File storage

Cloudflare R2 is the only object storage.

All files use the same `attachments` resource.

`attachmentType`:
- PHOTO
- DOCUMENT
- RECORDING

Preferred upload flow:
1. Client requests upload authorization.
2. Backend validates authentication, authorization and file metadata.
3. Backend generates short-lived R2 upload authorization.
4. Client uploads directly to R2.
5. Client calls finalize endpoint.
6. Backend verifies the expected R2 object.
7. Backend inserts attachment metadata into PostgreSQL.

The client must never be able to use an arbitrary R2 object key to access
another resource.

## Attachment rules

PHOTO:
- property_id required
- document_type must be NULL

DOCUMENT:
- property_id required
- document_type required

RECORDING:
- inquiry_id required
- document_type must be NULL

`file_size_bytes` stores the attachment size in bytes.

## Inquiry recording rule

ADMIN-created inquiry:
- at least one RECORDING attachment required.

EMPLOYEE-created inquiry:
- recording optional.

This rule is enforced server-side using the authenticated user's role.

## Response envelope

Success:
`{"success":true,"data":{}}`

Collection:
`{"success":true,"data":[],"pagination":{"page":1,"pageSize":20,"total":0,"totalPages":0}}`

Error:
`{"success":false,"error":{"code":"VALIDATION_ERROR","message":"...","details":[]},"requestId":"..."}`

## Pagination

page >= 1, default 1.
pageSize 1..100, default 20.

## Public API

Public responses must never expose:
- customer PII
- employee information
- assignment history
- audit information
- R2 credentials
- internal object keys unless intentionally exposed through signed URLs

## HTTP statuses

200 read/update
201 create
204 no response body
400 validation
401 authentication
403 authorization
404 not found
409 conflict
413 file too large
415 unsupported media type
422 semantic validation
429 rate limited
500 unexpected error

## Error codes

AUTH_INVALID_CREDENTIALS
AUTH_TOKEN_INVALID
AUTH_MASTER_ACCESS_REQUIRED
FORBIDDEN
VALIDATION_ERROR
USER_NOT_FOUND
CUSTOMER_NOT_FOUND
PROPERTY_NOT_FOUND
INQUIRY_NOT_FOUND
INQUIRY_ASSIGNMENT_INVALID
INQUIRY_RECORDING_REQUIRED
ATTACHMENT_NOT_FOUND
FILE_TYPE_NOT_ALLOWED
FILE_SIZE_LIMIT_EXCEEDED
STORAGE_UPLOAD_FAILED
STORAGE_FINALIZATION_FAILED
FOLLOW_UP_NOT_FOUND
NOTIFICATION_NOT_FOUND
CONFLICT
RATE_LIMITED
