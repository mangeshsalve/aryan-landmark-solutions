# CLAUDE.md — Aryan Landmark Solutions Backend

Read this before doing anything else in this repo. It replaces the older
CLAUDE.md, which described a previous 16-table/Cloudinary design that is
no longer in effect (see "Superseded design" below if you're wondering
why old references don't match).

## Authoritative documents

Per README.md, these are the source of truth — read them before making
architectural decisions:

- `docs/database/database-design.md`
- `docs/database/schema.sql`
- `docs/database/erd.mmd`
- `docs/api/openapi.yaml`
- `docs/api/api-conventions.md`
- `docs/architecture/greenfield-implementation-plan.md`

A few other docs (`system-architecture.md`, `security-architecture.md`,
`deployment-architecture.md`, `business-requirements.md`) still describe
the old design and are **not** authoritative. Don't use them to resolve
questions; if something's ambiguous, ask rather than infer from those
files.

## Stack

Node.js, TypeScript, NestJS, Prisma, PostgreSQL, Cloudflare R2. No
refresh tokens. No Cloudinary. No local file storage in production.

## Final database design — exactly 6 tables

`users`, `properties`, `attachments`, `inquiries`, `inquiry_assignments`,
`audit_logs`. Do not add a 7th table without an explicit, unambiguous
instruction to do so — this has been a hard constraint through every
phase so far.

Three concepts all live in `users`, distinguished by `user_type`:
- `APPLICATION_USER` (role `ADMIN`/`EMPLOYEE`) — can log in
- `CUSTOMER` — customer master data, `role`/`password_hash` always NULL,
  cannot log in
- `MASTER` — separate management account, own JWT boundary, manually
  provisioned (no registration endpoint anywhere)

`attachments` is a single unified table for `PHOTO`/`DOCUMENT`/
`RECORDING` — no separate `inquiry_recordings`/`property_photos`/etc.
tables.

## What's built (Phases 1–5, all reviewed and approved)

- **Phase 1** — NestJS foundation: config/env validation (fails fast on
  missing required vars), structured logging (`nestjs-pino`, secrets
  redacted), global exception filter (matches the error envelope in
  `api-conventions.md`), request-ID propagation, `/health` with real DB
  check, `prisma/schema.prisma` matching `schema.sql`.
- **Phase 2** — Authentication & authorization: `POST /auth/login`
  (APPLICATION_USER), `POST /master-auth/login` (MASTER). Two
  independently-secreted JWT types (`JWT_ACCESS_SECRET` /
  `MASTER_JWT_ACCESS_SECRET`) — a token from one boundary is
  cryptographically incapable of passing the other's guard.
  `JwtApplicationAuthGuard`, `JwtMasterAuthGuard`, `RolesGuard` +
  `@Roles(...)`, `@CurrentUser()`. bcrypt (via `bcryptjs`) for password
  hashing. Rate-limited login endpoints.
- **Phase 3** — Customer Master Data: `GET/POST /customers`,
  `GET/PATCH /customers/:id`. ADMIN + EMPLOYEE only. Duplicate check on
  mobile/email. Introduced the (previously nonexistent) minimal
  `AuditService` — now used everywhere audit events are needed.
- **Phase 4** — Property Master Data: `GET/POST /properties`,
  `GET/PATCH /properties/:propertyId`. Same authorization pattern.
  `propertyCode` auto-generated if not supplied (see "Open decisions"
  below — this was flagged, not finalized). Category/status enums
  enforced at the DTO layer.
- **Phase 5** — Cloudflare R2 + unified attachments: `StorageService`
  abstraction, `CloudflareR2StorageService` implementation (constructs
  its S3 client lazily — never touches the network during app startup
  or when unconfigured). `POST /attachments/upload-url`,
  `POST /attachments`, `GET /attachments`,
  `DELETE /attachments/:attachmentId`. R2 credentials are still not set
  (all blank in `.env.example`/`.env`) — every R2-dependent operation
  throws a clear `StorageNotConfiguredException` (503,
  `STORAGE_UPLOAD_FAILED`) rather than pretending to succeed.

Test count at end of Phase 5: **62 passing** (unit + a Phase 2 e2e
suite), 0 failures, no known regressions.

## Established conventions — follow these, don't reinvent per phase

- **Module shape**: `<name>.module.ts`, `.controller.ts`, `.service.ts`,
  `dto/`, a `<name>.mapper.ts` for response shaping (explicit allow-list,
  never a deny-list — this is how `passwordHash` etc. never leak).
- **Response envelope**: `{success, data}` / `{success, data, pagination}`
  matching `api-conventions.md`. Note: `GET /attachments` has **no**
  pagination — check the actual OpenAPI schema per-endpoint rather than
  assuming pagination everywhere.
- **Authorization pattern**: `@UseGuards(JwtApplicationAuthGuard,
  RolesGuard) @Roles('ADMIN', 'EMPLOYEE')` at the controller level.
  MASTER has not been granted access to any business-data module so far
  — don't add it without an explicit instruction, per every phase's
  authorization section.
- **`createdBy`/`updatedBy`/actor identity**: always from
  `@CurrentUser().sub` (the verified JWT), never the request body. DTOs
  don't even declare those fields — `forbidNonWhitelisted` on the global
  `ValidationPipe` rejects an attempt to send them.
- **Errors**: typed exception classes in
  `src/common/exceptions/app.exception.ts`, each carrying one of the
  documented `error.code` values from `api-conventions.md`. Add new ones
  there rather than throwing generic `HttpException`.
- **Domain enums**: `src/common/types/domain-enums.ts` has hand-written
  string-literal unions mirroring `schema.prisma`'s enums, used in type
  positions instead of Prisma's generated enum types. This exists
  because `prisma generate` has never successfully produced a real
  client in the sandbox this was built in (see "Environment note")	—
  it may be unnecessary in your environment. If `prisma generate` works
  for you, using the real generated enums going forward is fine and
  arguably preferable; you don't need to keep extending the hand-written
  ones out of consistency alone.
- **Audit**: `AuditService.record({...})` for every create/update/delete
  that matters — check what the current phase's instructions require
  auditing before adding new event types.

## Environment note — Prisma engine binaries and migration history

Phases 1-8.1 were built in a sandboxed environment where
`binaries.prisma.sh` was network-blocked, so `prisma validate`/
`generate`/`migrate` never actually ran. The original 6 tables were
therefore created by applying `docs/database/schema.sql` directly against
Postgres, not through `prisma migrate` — every environment of this
project prior to Phase 9B was set up this way.

**As of Phase 9B**, the Prisma engine binaries are reachable, and real
migration history exists:

- `prisma/migrations/20260101000000_baseline_initial_schema` — a
  baseline migration representing the *original, pre-Phase-6* 6-table
  schema (no `submitted_at`, no `properties.is_public`), including the
  four CHECK constraints and two partial/expression unique indexes
  (`chk_users_identity`, `uq_users_email`, the `properties`
  numeric/coordinate CHECKs, `chk_attachment_relationship`,
  `chk_attachment_document_type`, `chk_attachment_size`,
  `uq_property_primary_photo`) that are **still not expressible in
  Prisma's schema DSL** — `prisma/schema.prisma` itself doesn't declare
  them, but this migration's raw SQL does.
- `20260824000000_add_inquiry_submitted_at` (Phase 6) and
  `20260824010000_add_property_is_public` (Phase 8.1) — additive
  columns, unchanged.
- `20260825000000_inquiry_buyer_seller_matching` (Phase 11) — converts
  `inquiries.type` from free-text `VARCHAR(50)` to the new `inquiry_type`
  enum (`BUYER`/`SELLER`), and adds `preferred_city`, `preferred_pincode`,
  `max_budget`. **Not a naive Prisma-generated diff**: `prisma migrate
  diff` proposes a destructive `DROP COLUMN "type"` + `ADD COLUMN` for
  this exact change, which would silently discard every existing
  inquiry's `type` value — this migration was hand-written instead to
  normalize existing free-text values (`'Sell'`/`'SELL'` → `'SELLER'`,
  `'Buy'`/`'BUYER'` → `'BUYER'`, anything else → `NULL`) and convert the
  column in place with a `USING` cast. Verified against a real database
  seeded with exactly this messy data in Phase 11 — no rows lost.

**`docs/database/schema.sql` is a current-schema reference document, not
migration history.** It is kept up to date (it already includes
`submitted_at` and `is_public`, added directly into the `CREATE TABLE`
blocks in Phase 6/8.1) purely for readability. It must never be executed
directly against a database Prisma is expected to manage — see its own
header comment. **`npx prisma migrate deploy` is the only supported way
to initialize or change a production database's schema.** Never
`prisma db push` and never `prisma migrate reset` against a database that
holds real data — both are explicitly unsupported for this project.

Three bootstrap scenarios, verified in Phase 9C (see that report for the
exact commands and real-database test transcripts):

1. **Fresh, empty database** — `npx prisma migrate deploy` and nothing
   else. Verified: applies all three migrations in order, reaches the
   exact current schema. No manual `schema.sql` step, ever.
2. **Existing historical database** (created from `schema.sql` as it was
   *before* Phase 6 — i.e. it genuinely lacks `submitted_at` and
   `properties.is_public`): mark the baseline as already applied, once,
   without executing it, then deploy:
   ```
   npx prisma migrate resolve --applied 20260101000000_baseline_initial_schema
   npx prisma migrate deploy
   ```
   Verified in Phase 9C on a database seeded from an older schema.sql
   shape: the two incremental migrations then apply cleanly with no data
   loss.
3. **A database created by running the *current* `schema.sql` directly**
   — this already contains `submitted_at`/`is_public` from the start.
   **Do not** run the scenario-2 commands against it: `resolve --applied`
   on the baseline would succeed, but the subsequent
   `add_inquiry_submitted_at`/`add_property_is_public` migrations would
   then fail with "column already exists" (`P3018`) — confirmed by a
   real failing run in Phase 9C. There is no generic automatic repair for
   this case (deliberately not built — the right column-by-column
   assessment depends on exactly how that database was created). Anyone
   in this situation needs an explicit, manual schema/migration alignment
   review before marking anything as applied — do not guess.

## Open decisions flagged, not yet resolved

1. **`propertyCode` generation format** (Phase 4) — no format is
   documented anywhere. Current implementation: `PROP-` + 8 random
   uppercase hex chars if the client doesn't supply one. Placeholder,
   flagged for confirmation.
2. **`/customers` API ownership mismatch** (Phase 3) — `openapi.yaml`
   only documents `POST /master/customers` (master-scoped) for creation
   and a bare `GET /customers` list; the actual implementation has
   ADMIN/EMPLOYEE create/read/update directly via `/customers`, per
   explicit phase instructions. `openapi.yaml` needs updating to match
   before this drifts further.
3. **`STORAGE_UPLOAD_FAILED` reused for delete** (Phase 5) — no
   dedicated error code exists for "R2 not configured" on a delete
   operation; it currently reuses the upload-url failure code.
4. **Object-key trust model** (Phase 5) — no pending-upload tracking
   table exists (correctly — no new tables allowed), so the finalize
   step trusts a client-echoed R2 key only after prefix-pattern
   matching + an R2 existence check, not a server-held record of what
   was actually issued.
5. **Buyer/property matching assumptions** (Phase 11) — three deliberate,
   flagged design decisions rather than confirmed business requirements:
   (a) location match is city-only (`preferred_city` vs `property.city`)
   — `preferred_locality` was considered and not added, on the reasoning
   that the separately-weighted pincode criterion already covers
   finer-grained precision; (b) budget is a single `max_budget` ceiling
   compared against `property.price`, not a min/max range — chosen
   because `properties.price` is itself a single value, not a range;
   (c) no currency/unit conversion exists — `max_budget` and
   `property.price` are compared as raw numbers, correct only because
   every property in this project currently uses `price_unit = 'INR'`.
   None of these are enforced anywhere beyond application logic; revisit
   if a real multi-currency or locality-level requirement emerges.

## Scope discipline (has held for 5 phases — keep it up)

Every phase has explicitly excluded work that belongs to later phases
(inquiries, assignments, reports, public API, Flutter, Google
Maps/Mapbox, refresh tokens, new tables). Don't implement ahead of the
current phase's explicit instructions, even if it looks like an obvious
next step — say what you'd do and wait to be asked, the way every prior
phase report ended with an explicit STOP.

## Likely next phase (per greenfield-implementation-plan.md's module order)

Inquiries — `handled_by`/`assigned_to`, assignment history writes to
`inquiry_assignments`, and (explicitly deferred from Phase 5) the
ADMIN-recording-mandatory / EMPLOYEE-recording-optional business rule.
Nothing has been built here yet beyond the Prisma model itself.
