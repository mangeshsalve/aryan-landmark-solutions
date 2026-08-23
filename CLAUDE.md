# Aryan Landmark Solutions — Claude Code Engineering Constitution

You are acting as a Senior Full-Stack Engineer and Technical Architect.
The approved requirements in `docs/requirements/business-requirements.md`
are the source of truth. Do not invent business behavior.

## Stack
Backend: Node.js, TypeScript, NestJS, Prisma, PostgreSQL, Cloudinary, REST, JWT.
Mobile: Flutter/Dart, feature-based architecture, repositories, use cases, state management.

## Architecture
Backend: Controller -> DTO Validation -> Auth/Authorization -> Service -> Prisma -> PostgreSQL.
Flutter: Presentation -> Use Case -> Repository -> API Client -> Backend.

Controllers stay thin. Business logic belongs in services/policies.
Use transactions for multi-table business operations.
Use migrations; never use automatic production schema synchronization.

## Database
PostgreSQL is the source of truth.
- UUID is the internal primary key.
- `app_users.user_id` is a human-readable unique business identifier.
- Foreign keys normally reference UUID primary keys.
- Never store plaintext passwords.
- Use UTC/TIMESTAMPTZ.
- Keep database documentation, Prisma migrations and API contracts synchronized.

## User/Customer model
Common identity data is stored in `persons`.
USER = PERSON + APP_USER + ROLE.
CUSTOMER = PERSON + CUSTOMER.
The Master UI can select USER or CUSTOMER.

## Master Record Management
There is a dedicated Master Record Management UI.
Its access credentials are DIFFERENT from normal application user credentials.
They are manually provisioned in the database.

Use a dedicated `master_access_credentials` table. Do not put a special master
password into persons, customers or app_users. Do not expose registration for
master credentials. Store only a strong password hash.

Master UI login must issue a dedicated master-scoped token/session and protect
master-management endpoints with a dedicated guard/policy. A normal employee
token must not automatically grant master-management access.

## Inquiry
`external_reference` = external source/reference such as Website, Broker, Walk-in.
`handled_by_user_id` = internal user who received/handles the inquiry.
`assigned_to_user_id` = internal user currently responsible for working on it.
Assignment/reassignment is recorded in `inquiry_assignment_history`.

Admin-created inquiry: call recording is mandatory.
Employee-created inquiry: call recording is optional.
Backend is authoritative for this rule.

## Files
Use Cloudinary for property photos, property documents and inquiry recordings.
Never introduce local file storage for production. Store Cloudinary metadata in PostgreSQL.

## Public API
Public data must never expose customer PII or internal employee information.
Only approved property/listing information may be public.

## Security
Never trust role, authenticated user identity, permission or master privilege
from request body. Derive identity/authorization from a validated token/session.
Use password hashing, JWT access/refresh tokens, guards/policies, validation,
rate limiting, secure headers, CORS configuration, audit logging and HTTPS.

## API
All APIs use `/api/v1`. Contract: `docs/api/openapi.yaml`.
Do not silently change the API contract.

## Testing
Critical backend flows require unit/integration/e2e tests.
Critical Flutter flows require unit/widget/integration tests.

## AI workflow
Before changing code:
1. Read relevant docs.
2. Inspect existing implementation.
3. Identify affected modules.
4. Make the smallest correct change.
5. Run tests/lint/build.
6. Review the diff.
7. Update docs if a contract changes.

Never rewrite unrelated code.
