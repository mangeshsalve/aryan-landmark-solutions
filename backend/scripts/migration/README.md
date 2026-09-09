# PostgreSQL → Cloudflare D1 migration tooling (Phase 10)

This directory contains **local/test-only** tooling that proves existing
PostgreSQL data can be correctly transformed and loaded into the Worker's
D1 schema. It does **not** perform, and cannot by construction be pointed
at, a production migration — see "Safety" below.

## Pipeline

Four independent, re-runnable steps, each reading/writing its own file
under `migration-data/` (gitignored — never commit real exported data):

```
export-postgres.js  -> migration-data/export.json       (PostgreSQL, read-only)
transform-data.js   -> migration-data/transformed.json  (pure, offline, no DB connection)
import-d1.js         -> migration-data/import.sql + LOCAL D1        (writes, --local only)
verify-migration.js  -> stdout report                    (PostgreSQL + LOCAL D1, read-only)
```

Plus two supporting scripts:

- `seed-test-data.js` — adds a small set of supplementary rows to the
  local PostgreSQL database so every category Phase 10 asks for is
  represented (an INACTIVE user, a public property, an unassigned
  inquiry, a reminder-enabled follow-up, one read + one unread
  notification, a primary photo). Idempotent — safe to re-run. Never
  deletes or modifies an existing row.
- `reset-d1.js` — clears all 8 application tables in the **local** D1
  database (not the migration-bookkeeping tables, not `.wrangler/state`
  itself) so the import step can be re-run from a clean, verifiable
  baseline without any manual repair.

## Usage

```bash
# One-time: make sure the local Postgres already has representative data.
ALLOW_DATA_MIGRATION=true node scripts/migration/seed-test-data.js

# The actual pipeline:
ALLOW_DATA_MIGRATION=true node scripts/migration/export-postgres.js
node scripts/migration/transform-data.js
ALLOW_DATA_MIGRATION=true node scripts/migration/import-d1.js
ALLOW_DATA_MIGRATION=true node scripts/migration/verify-migration.js

# To re-run the import cleanly (repeatable testing):
ALLOW_DATA_MIGRATION=true node scripts/migration/reset-d1.js
ALLOW_DATA_MIGRATION=true node scripts/migration/import-d1.js
ALLOW_DATA_MIGRATION=true node scripts/migration/verify-migration.js
```

`transform-data.js` needs no environment variable — it never opens a
database connection, only reads/writes local JSON files.

## Safety

Every script that touches a database calls `lib/safety.js`'s
`assertMigrationAllowed()` first, which enforces two independent things:

1. **Explicit opt-in.** `ALLOW_DATA_MIGRATION=true` must be set. Nothing
   runs from a bare `node <script>.js`.
2. **Production-target refusal.** `DATABASE_URL`/`NODE_ENV`/`D1_ENV` are
   checked for the substring `"prod"`, and `DATABASE_URL`'s hostname
   must be `localhost`/`127.0.0.1`/`::1`. If either check fails, the
   script refuses unconditionally — the opt-in flag does **not**
   override this.

D1 writes are additionally hardcoded to `--local --config wrangler.jsonc`
in `import-d1.js`/`reset-d1.js` themselves — there is no flag or
environment variable anywhere in this tooling that can select `--remote`.
A real production migration is a distinct, future, explicitly-approved
phase, not something reachable from here.

## Type transformation matrix

See the Phase 10 report (Section E) for the full table. Summary:

| PostgreSQL / Prisma | D1 / SQLite | Rule |
|---|---|---|
| `uuid` (every id/FK) | `TEXT` | preserved byte-for-byte, never regenerated |
| `boolean` | `INTEGER` (0/1) | `NULL` stays `NULL` where the column is nullable |
| `jsonb` (`audit_logs.old_values`/`new_values`) | `TEXT` | `JSON.stringify`'d; `NULL` stays `NULL` |
| `timestamptz` | `TEXT` | ISO-8601 UTC string, matching every Worker-written timestamp |
| `Decimal(18,2)` money (`properties.price`, `inquiries.max_budget`) | `INTEGER` minor units | `Math.round(rupees * 100)` — same function as `src/worker/utils/money.ts` |
| `Decimal` area/lat/lng | `REAL` | direct numeric conversion, no unit change |
| `BigInt` (`attachments.file_size_bytes`) | `INTEGER` | direct numeric conversion (safe range) |

## Batching (Phase 11)

`import-d1.js` splits its generated INSERT/UPDATE statements into
multiple sequentially-executed SQL files rather than one single file,
controlled by `MIGRATION_BATCH_SIZE` (default `500` rows per file):

```bash
MIGRATION_BATCH_SIZE=500 ALLOW_DATA_MIGRATION=true node scripts/migration/import-d1.js
```

Each batch file is written to `migration-data/batches/` (gitignored,
regenerated on every run) and executed with its own
`wrangler d1 execute --local --config wrangler.jsonc --file <batch>.sql`
call, in the same global dependency order as the unbatched version
(users pass 1 batches, then every other table's batches in FK order,
then users pass 2/backfill batches last). Set `MIGRATION_BATCH_SIZE` to
a number at or above the largest table's row count to reproduce the
original single-file behavior exactly.

**Why this exists**: `wrangler d1 execute --file` has no documented hard
limit, but Cloudflare's own guidance is to keep individual `execute`
calls reasonably sized, and a single multi-thousand-statement file is
harder to diagnose or resume if one table's import fails partway
through. Batching also gives a natural per-table progress readout for
large imports.

**Tested locally this phase**: `MIGRATION_BATCH_SIZE=2` against the
~175-row local dataset (deliberately far smaller than the default, to
force many small batches rather than to simulate real production
volume) — produced 93 sequential batch files and 93 wrangler
invocations, all succeeded, and a full `verify-migration.js` run
afterward still passed all 38/38 checks with results identical to the
unbatched run. This proves the chunking + sequential-execution +
dependency-ordering mechanism itself is correct; it does not by itself
prove any particular batch size is right for real production volume,
since that depends on data not available in this environment (see the
Phase 11 report's Production Data Volume Assessment section).

## Production migration (Phase 13)

A **separate, parallel set of scripts** exists for the real production
PostgreSQL → production D1 migration. They are gated independently from
everything above and cannot be reached by any local command:

```
export-postgres-production.js  -> migration-data/export-production.json       (PRODUCTION PostgreSQL, read-only)
transform-data.js              -> migration-data/transformed-production.json  (same pure transformer, different file names via env vars)
import-d1-production.js        -> PRODUCTION D1 (aryan-landmark-production), batched, --remote
verify-migration-production.js -> stdout report (PRODUCTION PostgreSQL export + PRODUCTION D1, read-only)
```

Usage:

```bash
# Export (read-only, PRODUCTION_DATABASE_URL — never DATABASE_URL):
ALLOW_PRODUCTION_MIGRATION=true PRODUCTION_MIGRATION_CONFIRM=I_UNDERSTAND_THIS_TARGETS_PRODUCTION \
  PRODUCTION_DATABASE_URL="postgresql://..." node scripts/migration/export-postgres-production.js

# Transform (same pure script as local, different file names):
MIGRATION_EXPORT_FILE=export-production.json MIGRATION_TRANSFORMED_FILE=transformed-production.json \
  node scripts/migration/transform-data.js

# Import (writes to real production D1, batched):
ALLOW_PRODUCTION_MIGRATION=true PRODUCTION_MIGRATION_CONFIRM=I_UNDERSTAND_THIS_TARGETS_PRODUCTION \
  D1_PRODUCTION_DATABASE_NAME=aryan-landmark-production MIGRATION_BATCH_SIZE=500 \
  node scripts/migration/import-d1-production.js

# Verify (read-only against production D1 + the export snapshot):
ALLOW_PRODUCTION_MIGRATION=true PRODUCTION_MIGRATION_CONFIRM=I_UNDERSTAND_THIS_TARGETS_PRODUCTION \
  D1_PRODUCTION_DATABASE_NAME=aryan-landmark-production node scripts/migration/verify-migration-production.js
```

**Safety design** (see `lib/safety.js`):

- `ALLOW_PRODUCTION_MIGRATION=true` and an exact-phrase
  `PRODUCTION_MIGRATION_CONFIRM` are both required — independent of, and
  never satisfied by, the local scripts' `ALLOW_DATA_MIGRATION`.
- The production export reads `PRODUCTION_DATABASE_URL`, a completely
  separate variable from `DATABASE_URL` — the two can never collide or
  silently substitute for each other. Its hostname must not be
  local/loopback unless `PRODUCTION_MIGRATION_DRY_RUN=true` is also set
  (a deliberate, loudly-logged escape hatch for self-testing this
  tooling's *mechanics* against a local database — never a real
  migration path).
- The production import/verify scripts require
  `D1_PRODUCTION_DATABASE_NAME=aryan-landmark-production` as an
  independent re-confirmation of the target, on top of whatever
  `wrangler.production.jsonc` itself contains — a stale or edited config
  file alone cannot redirect a write.
- `--remote` and `--config wrangler.production.jsonc` are hardcoded in
  the production scripts themselves, exactly as `--local` is hardcoded
  in the local scripts — no flag or env var can point either family at
  the other's target.
- `export-postgres.js`/`import-d1.js`/`reset-d1.js`/`verify-migration.js`
  (the original Phase 10 local scripts) are **unmodified in behavior** —
  they still refuse anything production-shaped via
  `assertMigrationAllowed()`, exactly as before. Batch-building
  (`lib/batch-builder.js`) and verification checks
  (`lib/verify-checks.js`) were extracted into shared modules so both
  families run identical logic, but each script's own safety gate and
  hardcoded target flag are untouched.
- The production scripts invoke `wrangler` by spawning its JS entry
  point directly via `node.exe` (`lib/run-wrangler.js`) rather than
  `npx` + `shell: true` — required because `--remote --file` doesn't
  return real query results (only an execution summary) so verification
  needs `--command`, and `--command` with `execFileSync({shell:true})`
  hits the same Windows argument re-splitting bug documented above.
  `shell:false` avoids both.

## Known limitation

`import-d1.js` generates literal SQL `INSERT`/`UPDATE` statements (via
`lib/sql-format.js`'s escaping) rather than using parameterized queries,
because `wrangler d1 execute --file` takes a plain `.sql` file, not a
bind-parameter API. This is safe here because every value originates
from our own `transform-data.js` output (never from an HTTP request),
but if this tooling is ever extended to pull from an untrusted source,
that assumption would need to be revisited.
