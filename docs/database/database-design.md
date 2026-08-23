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

Category:
- RESIDENTIAL
- INDUSTRIAL
- COMMERCIAL
- AGRICULTURAL

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

`handled_by_user_id` = internal employee responsible for handling the inquiry.

`assigned_to_user_id` = employee currently assigned to work on it.

These remain separate because an employee can receive an inquiry and assign it
to another employee.

## Call recording rule

ADMIN-created inquiry:
- at least one RECORDING attachment is mandatory before creation is complete.

EMPLOYEE-created inquiry:
- recording is optional.

The backend determines the creator role from the authenticated token.

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

Versioned Prisma migrations are authoritative for PostgreSQL changes.

The SQL in this package is the reference/initial migration specification.
