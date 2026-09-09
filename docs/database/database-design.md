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
- owner_customer_id

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

`area_unit`: controlled enum (`property_area_unit`) — was free-text
`VARCHAR(20)` before, with inconsistent real values (`SQ.FT`/`sq.ft`/
`SQ FT`). Values: `SQ_FT`, `SQ_YD`, `SQ_M`, `ACRE`, `GUNTHA`, `HECTARE` —
SQ_FT/SQ_YD/SQ_M for residential/commercial-scale listings, the other
three for agricultural land. Existing rows were normalized (not left
inconsistent) by the migration that introduced the enum — see that
migration's header comment for the exact mapping; nothing was silently
changed, every real value at the time mapped unambiguously to `SQ_FT`.
`SQ_YD`/`SQ_M` were added later by a separate, purely additive
`ALTER TYPE ... ADD VALUE` migration (no existing row touched — no
property had ever held a "Sq Yd"/"Sq M" value, since neither was a valid
option before that migration), to match Flutter's six-value area-unit
picker.

`price_unit` (this phase): no longer client-settable. This application
is India-only — `PropertiesService.create()` now hardcodes `'INR'`
rather than reading it from the request, and it's absent from
`UpdatePropertyRequest` entirely (never editable after creation). The
column and its value are both retained (not dropped) — every existing
row was already `'INR'`, so no data changed. Not used in any business
logic or calculation (confirmed before this phase); matching already
assumed INR on both sides, unconditionally.

`owner_customer_id` (Phase 26, nullable, `REFERENCES users(id)`): the
actual CUSTOMER who owns the property — a genuinely new, explicit
relationship, not a repurposing of anything that already existed.
Deliberately distinct from `created_by` (whichever ADMIN/EMPLOYEE staff
member entered the listing — never assumed to be the owner) and never
inferred from a SELLER inquiry linked to the property (rejected as an
ownership source: not guaranteed to exist, not guaranteed unique if
multiple SELLER inquiries reference the same property). `NULL` means
"no owner assigned" — every property that existed before this phase has
`NULL` here, and no owner is ever assigned automatically; a staff member
(ADMIN or EMPLOYEE, same authorization as property create/update
generally) must explicitly pick one via the property create/edit form,
reusing the existing customer picker. The referenced user must have
`user_type = 'CUSTOMER'` — enforced at the application layer on write
(`POST`/`PATCH /properties`), not by a schema-level CHECK constraint
(cross-table lookups aren't expressible in one), the same enforcement
style `inquiries.customer_id`'s own CUSTOMER-only rule already uses.
`GET /properties` and `GET /properties/{propertyId}` both return the
flat `ownerCustomerId` plus a small nested `owner: {id, name, mobile}`
summary (`null` when unassigned) — the list endpoint gets this via one
`LEFT JOIN` to `users`, not a per-row lookup.

## 3. attachments

This is the single file metadata table.

`attachment_type`:
- PHOTO
- DOCUMENT
- RECORDING

Examples:

PHOTO:
- property photo, or a photo captured during an ADMIN's initial call
  (Phase 13B)
- exactly one of property_id / inquiry_id required (never both)

DOCUMENT:
- 7/12
- Sale Deed
- Property Card
- NOC
- Other
- exactly one of property_id / inquiry_id required (never both)

RECORDING:
- call recording
- inquiry_id required
- property_id must be absent

The same table therefore supports multiple photos, documents and call
recordings without another recording table.

Phase 13B — inquiry-centric capture: an ADMIN taking a call has no
customer or property record yet. PHOTO/DOCUMENT attachments may
therefore reference the inquiry instead of a property
(`chk_attachment_relationship` requires `property_id IS NOT NULL OR
inquiry_id IS NOT NULL`, not just `property_id`), so they can be
captured before either master record exists. The property-linked flow
is unchanged and still fully supported.

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

`customer_id` (nullable, Phase 13B) and `property_id` (already nullable) —
both NULL on a lightweight, ADMIN-created inquiry captured during a call,
before the customer or property has been identified. An EMPLOYEE fills
these in later via `PATCH /inquiries/{id}` once they've reviewed the
recording/photos/documents attached to the inquiry.

`customerName` (API response field, this phase, no schema column) —
`GET /inquiries` embeds the linked customer's display name directly, via
the same single relation-`select` already used for `handledBy`/
`assignedTo` (Phase 14A), so a Flutter list screen never needs a
per-row `GET /customers/{id}` follow-up call. Null exactly when
`customer_id` is null.

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
- city
- state
- pincode
- locality
- max_budget
- submitted_at

`handled_by_user_id` = internal employee responsible for handling the inquiry.

`assigned_to_user_id` = employee currently assigned to work on it.

These remain separate because an employee can receive an inquiry and assign it
to another employee.

`submitted_at` (nullable): NULL means the inquiry has not been submitted yet;
non-NULL is the timestamp it was submitted. Set only by the submission
operation (`POST /inquiries/{id}/submit`) — never accepted from a create or
update request body. Once set, it is never cleared by normal updates.

`type` (nullable enum, `inquiry_type`: `BUYER` or `SELLER`, Phase 11) —
replaces the prior free-text field. Determines which side of a deal this
inquiry represents; see "Buyer/property matching" below.

`city`, `state`, `pincode`, `locality` (all nullable) — unified location
fields (this phase), replacing the old BUYER-only `preferred_city`/
`preferred_pincode` (no `preferred_state`/`preferred_locality` ever
existed). Used consistently by BOTH `BUYER` and `SELLER` inquiries:

- **BUYER**: directly client-editable, the buyer's stated preference —
  same as before, just renamed, plus the two new fields.
- **SELLER**: authoritatively synced from the linked `properties` row
  whenever `property_id` is set/changed (`InquiriesService`), or
  whenever the linked property's own location fields are edited
  (`PropertiesService.update()` propagates to every `SELLER` inquiry
  referencing it, in the same transaction as the property write) — never
  independently client-editable while a property is linked. If the
  property is later deleted, the inquiry's location snapshot is
  *preserved*, not cleared, even though `property_id` becomes `NULL`
  (via the existing `ON DELETE SET NULL`).
- `locality` is synced from `properties.locality` only — never
  `properties.address`, even when `locality` is empty (left `NULL`
  rather than falling back to the noisier free-text address field; full
  address fuzzy matching was explicitly deferred). It's the
  fuzzy/token-matching signal alongside `city`.

`max_budget` (nullable) stays BUYER-only, unchanged this phase — same
`NUMERIC(18,2)` precision as `properties.price` for direct comparison, no
currency/unit conversion (every property currently uses
`price_unit = 'INR'`).

## Buyer/property matching (Phase 11; bidirectional as of Phase 19A;
unified location fields as of this phase, with normalized city matching
and fuzzy locality matching — city is NOT fuzzy, see below)

`GET /inquiries/{inquiryId}/matches` — direction depends on the path
inquiry's own `type`:

- `type = SELLER` → finds `BUYER` inquiries that are a good fit.
- `type = BUYER` → finds `SELLER` inquiries that are a good fit.
- any other `type` (including `NULL`, a lightweight inquiry) → rejected.

Both directions are now genuinely symmetric — both sides read
`city`/`state`/`pincode`/`locality` directly from their own `inquiries`
row (no more "SELLER's location comes from `properties`, BUYER's from
`inquiries`" special-casing). Only price/budget stays asymmetric by
design: a SELLER's number always comes from its linked `properties.price`,
a BUYER's from `inquiries.max_budget` directly.

- **Pincode — 30%, mandatory gate**: exact match after normalization
  (trimmed at write time). No match ⇒ zero results — a hard
  precondition, not merely a scored criterion; replaces the old
  city-based mandatory pre-filter (`idx_inquiries_type_pincode`).
- **Location — up to 50%** = `MAX(cityScore, localityScore)`, not
  summed:
  - **city**: normalized (trimmed, lowercased, punctuation-stripped)
    exact compare — not raw string equality.
  - **locality**: token-overlap fuzzy match on the same normalization,
    with short/numeric/generic words (road, colony, highway, ...)
    filtered out so they alone can't drive a false-positive match.
- **Budget — 20%**: unchanged — the SELLER side's `properties.price` is
  less than or equal to the BUYER side's `inquiries.max_budget`.

`matchingScore = 30 (pincode, guaranteed once gated) + locationScore +
budgetScore` (0-100). Only matches with `matchingScore >= 70` are
returned, sorted highest first. Missing data on either side of a
comparison scores that criterion 0 (never assumed to match). The source
inquiry never appears in its own results.

**Achievable score values** (documentation only — a mathematical
consequence of the weights above, not a separate rule; the 70 threshold
itself is unchanged and is not being revisited here): pincode is
all-or-nothing to even reach scoring (30 once gated), location is 0 or
50, budget is 0 or 20 — so a gated candidate can only ever total `30`,
`50`, `80`, or `100`. There is no way to score, say, 60 or exactly 70.
Since 80 is the smallest of those four values that clears the `>= 70`
threshold, the *effective* minimum passing score under the current
scoring model is **80** — pincode plus budget alone (50) is never
enough; the location criterion (city or locality) must also match.

`status` is not checked — matching has never required `COMPLETED`.
Insufficient data: a `SELLER` inquiry with no `property_id` is rejected
(there is no price to match against); any source with no `pincode` yet
returns an empty result, not an error.

**Limitation (Phase 19A):** `properties.area`, `properties.category`, and
`properties.property_type` are not used as matching criteria in either
direction — `inquiries` has no corresponding "desired area/category/
property type" field for a buyer to compare against, and none was added
in this phase (out of scope; would require a schema change).

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

## Notifications (this phase)

`notifications` — in-app notifications. No notification system of any
kind existed before this phase (verified by repository-wide search).
Generic shape, deliberately mirroring `audit_logs`'
entity_type/entity_id/free-text-`type` pattern (same kind of
system-generated event record, just recipient-scoped and user-facing
instead of an admin trail): `user_id` (recipient), `type`, `title`,
`message`, `entity_type`/`entity_id` (optional, e.g. `INQUIRY`/the
inquiry id), `is_read`, `read_at`, `created_at`.

Produced by two events:

- An ADMIN assigning or reassigning an inquiry to an employee
  (`type = 'INQUIRY_ASSIGNED'`) — see `POST /inquiries/{inquiryId}/assign`
  and the reassignment path of `PATCH /inquiries/{inquiryId}`. Gated
  strictly on the calling actor's role being ADMIN: an EMPLOYEE
  assigning/reassigning an inquiry to another employee (an existing,
  unrestricted business capability) never produces a notification, and
  is never blocked by this feature either — it's a purely additive side
  effect of a successful assignment, not a precondition of one.
- A follow-up reminder becoming due (`type = 'FOLLOW_UP_REMINDER'`,
  Phase 38D) — created by a Cloudflare Cron-triggered scheduled job
  (`src/worker/scheduled/follow-up-reminders.ts`), not an HTTP route.
  Recipient is the parent inquiry's `assigned_to_user_id`; a due
  follow-up whose parent inquiry has no assignee is skipped, not
  notified to anyone else (no ADMIN/MASTER copy). Sent at most once per
  follow-up — see `follow_ups.reminder_sent_at` below.

No POST endpoint exists for creating a notification directly — every
type is only ever created as a side effect of a real business action or
scheduled job, never directly by a client, same as `audit_logs`.
`GET /notifications` and `PATCH /notifications/{id}` are both implicitly
scoped to the authenticated caller's own notifications only, and both
remain unchanged by the addition of the second event type — they read
generically off `type`/`entity_type`/`entity_id`, never special-casing a
specific type string.

`follow_ups.reminder_sent_at` (Phase 38D, nullable, `NULL` until a
`FOLLOW_UP_REMINDER` notification has actually been created for that
follow-up) is the idempotency marker preventing a duplicate reminder on
a later or overlapping scheduled run — set only after the notification
write succeeds, never speculatively beforehand. `follow_ups` itself
predates this doc (see the `schema.sql` header note) — full follow_ups
documentation remains a pre-existing gap this phase does not attempt to
backfill wholesale.

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
