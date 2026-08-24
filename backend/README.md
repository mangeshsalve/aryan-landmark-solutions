# Aryan Landmark Solutions — Backend

**Phase 1 only.** This is the production backend foundation — no business
logic yet. Authentication, master management, users/customers, properties,
attachments (Cloudflare R2), inquiries, and assignments all land in later
phases per `docs/architecture/greenfield-implementation-plan.md`.

## Stack

Node.js, TypeScript, NestJS, Prisma, PostgreSQL.

## What's in Phase 1

- NestJS application bootstrap (`src/main.ts`), `/api/v1` prefix, helmet,
  CORS from config, global validation (`whitelist` + `forbidNonWhitelisted`)
- Typed, validated environment/configuration loading (fails fast on
  missing/invalid env vars) — `src/config/`
- Structured JSON logging (`nestjs-pino`) with secret redaction and a
  request/correlation ID threaded through every log line and echoed back
  on the response (`x-correlation-id` header) — `src/common/logger/`,
  `src/common/interceptors/`
- Global exception handling matching the documented error envelope
  (`docs/api/api-conventions.md`) — `src/common/filters/`
- Prisma setup (`src/prisma/`) and schema (`prisma/schema.prisma`) matching
  the documented 6-table design exactly (`users`, `properties`,
  `attachments`, `inquiries`, `inquiry_assignments`, `audit_logs`)
- `GET /api/v1/health` — process + real PostgreSQL connectivity check
  (`src/health/`)

Not implemented yet (by design — see the file for what's still to build):
authentication, JWT, Cloudflare R2, and every business API.

## Prerequisites

- Node.js 20+ (developed/tested against Node 22)
- PostgreSQL 15+ running locally or reachable
- npm

## Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env: at minimum confirm DATABASE_URL points at a real Postgres
# instance and matching database (e.g. `createdb aryan_landmark`)
```

## Database

```bash
npm run prisma:validate      # checks prisma/schema.prisma is well-formed
npm run prisma:migrate:dev   # creates and applies the initial migration
npm run prisma:generate      # regenerates the Prisma Client (also runs
                              # automatically after migrate:dev)
```

> **Note on this development environment:** `prisma validate` / `generate`
> / `migrate` all shell out to download Prisma's Rust engine binaries from
> `binaries.prisma.sh` on first use. If you're running behind a restrictive
> network egress policy that blocks that domain, these commands will fail
> with a `403 Forbidden` checksum-fetch error — this is a network
> reachability issue, not a schema problem. Allow that domain (or use an
> environment with normal internet access) to run them.

## Running the app

```bash
npm run start:dev   # watch mode
npm run start        # single run
npm run build && npm run start:prod   # production build
```

Once running:
- Health check: `GET http://localhost:3000/api/v1/health`
- Swagger UI (non-production only): `http://localhost:3000/api/v1/docs`

## Quality checks

```bash
npm run format:check   # prettier
npm run lint:check     # eslint
npx tsc -p tsconfig.build.json --noEmit   # type-check without emitting
npm run test           # jest unit tests (none yet — Phase 1 has no
                        # business logic to test; the harness is wired
                        # and ready for later phases)
```

## Project structure

```
backend/
├── src/
│   ├── main.ts                 # bootstrap
│   ├── app.module.ts            # root module
│   ├── config/                  # env validation + typed config
│   ├── common/
│   │   ├── filters/              # global exception filter
│   │   ├── interceptors/         # request-id response header
│   │   ├── logger/               # structured logging (pino)
│   │   └── types/                # express type augmentation
│   ├── prisma/                   # PrismaService/PrismaModule
│   └── health/                   # /health endpoint + DB check
├── prisma/
│   └── schema.prisma
├── .env.example
└── package.json
```

## Source of truth

Per the repository README, the authoritative documents for this backend
are:
- `docs/database/database-design.md`
- `docs/database/schema.sql`
- `docs/database/erd.mmd`
- `docs/api/openapi.yaml`
- `docs/api/api-conventions.md`
- `docs/architecture/greenfield-implementation-plan.md`

A handful of other docs in the repository (`CLAUDE.md`,
`system-architecture.md`, `security-architecture.md`,
`deployment-architecture.md`, `business-requirements.md`, the top-level
`.env.example`) still describe an earlier Cloudinary/16-table design and
were **not** used to build this backend. They were intentionally left
unmodified in Phase 1.
