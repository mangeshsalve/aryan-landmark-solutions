# Aryan Landmark Solutions — Final Production Database Design

## Final table count

The application intentionally uses **6 PostgreSQL tables**:

1. users
2. properties
3. attachments
4. inquiries
5. inquiry_assignments
6. audit_logs

The previous `inquiry_attachment` and `inquiry_recordings` tables have been
consolidated into one `attachments` table.

## Storage

Cloudflare R2 is the only object storage.

PostgreSQL stores attachment metadata and the R2 object key. Actual binary
files are never stored in PostgreSQL.

## 1. users

Represents:
- APPLICATION_USER
- CUSTOMER
- MASTER

APPLICATION_USER:
- user_id required
- password_hash required
- role = ADMIN or EMPLOYEE

CUSTOMER:
- user_id NULL
- password_hash NULL
- role NULL

MASTER:
- user_id required
- password_hash required
- role NULL
- credentials manually provisioned in the database
- no public master-registration API

The backend derives authenticated identity and authorization from the token.
Never trust role/user identity from request bodies.

## 2. properties

Stores property details and location.

Important fields:
- property_code
- property_type
- category
- area
- area_unit
- price
- price_unit
- gat_no_details
- description
- address
- locality
- city
- state
- pincode
- latitude
- longitude
- map_url
- status
- is_public

Category:
- RESIDENTIAL
- INDUSTRIAL
- COMMERCIAL
- AGRICULTURAL

`is_public` (nullable: no, default FALSE): controls whether a property
appears in `GET /public/properties`. This is a separate flag from
`inquiries.is_public` — a property is not "public" merely because one of
its inquiries is public, and vice versa. Only an ADMIN may change it, via
`PATCH /properties/{propertyId}`. `GET /public/properties` requires both
`is_public = true` AND `status = 'AVAILABLE'` — `is_public` alone is not
sufficient (an ADMIN could mark a SOLD property `is_public` without
intending it to reappear in the public listing).

## 3. attachments

This is the single file metadata table.

`attachment_type`:
- PHOTO
- DOCUMENT
- RECORDING

Examples:

PHOTO:
- property photo
- property_id required
- inquiry_id optional

DOCUMENT:
- 7/12
- Sale Deed
- Property Card
- NOC
- Other
- property_id required
- inquiry_id optional

RECORDING:
- call recording
- inquiry_id required
- property_id optional

The same table therefore supports multiple photos, documents and call
recordings without another recording table.

### Size

Use:

`file_size_bytes BIGINT`

Do not use a generic `size` column. The name explicitly communicates that the
stored unit is bytes.

### Attachment document type

`document_type` is only populated for DOCUMENT attachments.

For PHOTO and RECORDING it is NULL.

## 4. inquiries

Connects a customer with a property and stores the current inquiry state.

Important fields:
- inquiry_number
- customer_id
- property_id
- type
- priority
- status
- external_reference
- handled_by_user_id
- assigned_to_user_id
- remarks
- is_public
- submitted_at

`handled_by_user_id` = internal employee responsible for handling the inquiry.

`assigned_to_user_id` = employee currently assigned to work on it.

These remain separate because an employee can receive an inquiry and assign it
to another employee.

`submitted_at` (nullable): NULL means the inquiry has not been submitted yet;
non-NULL is the timestamp it was submitted. Set only by the submission
operation (`POST /inquiries/{id}/submit`) — never accepted from a create or
update request body. Once set, it is never cleared by normal updates.

## Inquiry submission lifecycle and call recording rule

An inquiry is created via `POST /inquiries` with `submitted_at = NULL`. A
RECORDING attachment can only be created once the inquiry row already exists
(its `inquiry_id` foreign key requires it), so the recording requirement is
checked at a separate, later step — submission — rather than at creation:

1. `POST /inquiries` creates the inquiry (`submitted_at = NULL`).
2. The recording (if any) is uploaded via the existing attachment/R2 flow,
   referencing the now-existing `inquiry_id`.
3. `POST /inquiries/{id}/submit`:
   - rejects if the inquiry is already submitted (`submitted_at != NULL`);
   - for an inquiry whose creator (`created_by`) is an ADMIN, requires at
     least one `RECORDING` attachment for it, else rejects;
   - for an inquiry created by an EMPLOYEE, the recording is optional;
   - on success, sets `submitted_at = now()`.

The creator's role is read from `users.role` via the inquiry's `created_by`,
not from the caller submitting it — an EMPLOYEE can submit an ADMIN-created
inquiry, and the ADMIN recording requirement still applies (and vice versa).

## 5. inquiry_assignments

Stores assignment/reassignment history.

The current assignment remains in:
`inquiries.assigned_to_user_id`

Every reassignment:
1. updates the inquiry
2. inserts assignment history
3. creates an audit event
4. performs database changes in one transaction

## 6. audit_logs

Stores important security and business events.

Examples:
- LOGIN_SUCCESS
- LOGIN_FAILED
- MASTER_LOGIN_SUCCESS
- USER_CREATED
- CUSTOMER_CREATED
- PROPERTY_CREATED
- INQUIRY_CREATED
- INQUIRY_ASSIGNED
- INQUIRY_SUBMITTED
- ATTACHMENT_UPLOADED
- ATTACHMENT_DELETED
- PUBLIC_STATUS_CHANGED

`old_values` and `new_values` use JSONB.

## Deletion and consistency

Business records should normally be inactivated rather than hard-deleted.

When an attachment is deleted:
1. authorize the operation
2. delete/request deletion of the R2 object
3. remove metadata or mark it deleted according to the implementation policy
4. audit the operation

R2 operations cannot participate in a PostgreSQL transaction, so storage
failures must be explicitly handled and logged.

## Database source of truth

`prisma/schema.prisma` is the executable schema source of truth.

Versioned Prisma migrations (`backend/prisma/migrations/`) are the
**only** authoritative mechanism for creating or changing the PostgreSQL
schema. `npx prisma migrate deploy` is the documented, supported way to
initialize a fresh production database — never manual execution of
`docs/database/schema.sql`.

`docs/database/schema.sql` is a **current-schema reference document**,
kept up to date alongside `prisma/schema.prisma` for readability — it is
not a substitute for, and does not represent, the Prisma migration
history. A database created by running it directly does not have an
associated migration history and needs an explicit assessment before any
Prisma migration is marked as applied against it (see `CLAUDE.md`'s
"Environment note" and `backend/README.md`'s "Database" section for the
exact supported scenarios).
