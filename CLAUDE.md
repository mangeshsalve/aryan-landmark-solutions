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

## Environment note — Prisma engine binaries

Every phase so far was built in a sandboxed environment where
`binaries.prisma.sh` was network-blocked, so `prisma validate`/
`generate`/`migrate` have **never actually run successfully**. This
means:

- No real Prisma migration exists yet — only the hand-written
  `prisma/schema.prisma`.
- Several PostgreSQL CHECK constraints and one partial unique index from
  `schema.sql` (`chk_attachment_relationship`,
  `chk_attachment_document_type`, `chk_attachment_size`,
  `uq_property_primary_photo`) are **not expressible in Prisma's schema
  DSL** and have only ever been enforced at the application layer
  (service-level validation, a transaction for the primary-photo rule).

**If you have normal network access in Claude Code**, this is probably
resolved automatically — run `npm run prisma:migrate:dev` for real,
confirm it generates a client with the actual 6 models, and then
hand-add the four constraints above into the generated migration SQL
(their exact definitions are in `docs/database/schema.sql`, lines ~175–
208). This has been a standing item since Phase 1 and is worth doing
before Phase 6 adds more attachment-dependent logic.

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
