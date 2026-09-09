# Production Deployment Checklist — Cloudflare Workers + D1 Migration

Status as of this document's authoring (Phase 11): **preparation only**.
None of these boxes are checked yet. This file tracks the path from
"infrastructure prepared" to "safe to cut real traffic over" — it does
not itself authorize any step. Each unchecked box below requires an
explicit, separate approval before being acted on; checking a box here
is a record of what happened, not a request to do it.

The system this replaces (`aryan-landmark-backend` — Cloudflare
Containers wrapping the existing NestJS + PostgreSQL app, confirmed live
via `wrangler deployments list --name aryan-landmark-backend`) **must
remain the active production backend** until every box below is checked
and a human has explicitly approved cutover. Nothing in this checklist
authorizes decommissioning it.

## Checklist

- [ ] **1. Production D1 database created and named**, distinct from the
      POC's `aryan-landmark-test` (uuid `fa1ce8c1-3d48-4c42-b7a1-b9cd82d197c5`,
      currently 0 tables, belongs to `backend-d1-test`) — name and
      creation explicitly reviewed and approved by a human before
      `wrangler d1 create` runs.
- [ ] **2. Production D1 schema migrated**, via
      `wrangler d1 migrations apply <prod-db-name> --remote --config wrangler.jsonc`
      (the equivalent of `worker:d1:migrate:local` but targeting the new
      production database) run against the empty database from step 1,
      and confirmed to produce exactly the 8-table schema in
      `migrations/0001_initial_schema.sql`.
- [ ] **3. Production R2 bucket created and named**, distinct from the
      POC's `aryan-landmark-files` — name and creation explicitly
      reviewed and approved before `wrangler r2 bucket create` runs.
      Object key format and public URL strategy (see
      `src/worker/utils/attachment-rules.ts` /
      `CLOUDFLARE_R2_PUBLIC_BASE_URL`) confirmed to match what the
      Worker code actually produces/expects.
- [ ] **4. `wrangler.jsonc` updated** with the real production
      `database_id` from step 1 (replacing the current
      `00000000-0000-4000-8000-000000000001` placeholder), and the
      Worker's production `name` finalized and confirmed to not collide
      with `aryan-landmark-backend` or `backend-d1-test`.
- [ ] **5. All production secrets set** via `wrangler secret put` (never
      committed to `wrangler.jsonc`/`package.json`/Git): `DB` binding
      config only needs the database id above (not a secret);
      `JWT_ACCESS_SECRET`, `MASTER_JWT_ACCESS_SECRET`,
      `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID`,
      `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_BUCKET`,
      `CLOUDFLARE_R2_PUBLIC_BASE_URL` set as real secrets — each a
      genuinely new value for the new bucket/database, not copied from
      the POC's or the Containers Worker's existing secrets.
      `JWT_ACCESS_SECRET`/`MASTER_JWT_ACCESS_SECRET` in particular
      should be freshly generated, not reused from the PostgreSQL-backed
      system, so existing tokens issued by the old backend cannot be
      replayed against the new one (and vice versa).
- [ ] **6. `npm run worker:typecheck` and `npm run build` both pass**
      against the exact commit being deployed (confirmed clean this
      phase — see the Phase 11 report — but must be re-confirmed at
      actual deploy time against whatever commit is current then).
- [ ] **7. Production data volume assessed** from the real production
      PostgreSQL (not available in this environment — see the Phase 11
      report's Production Data Volume Assessment section) and an
      appropriate `MIGRATION_BATCH_SIZE` chosen based on real row counts,
      not just the small local test dataset.
- [ ] **8. Production PostgreSQL backup taken** immediately before
      migration begins (see Backup & Rollback Runbook below) and its
      location/retention confirmed.
- [ ] **9. Full migration pipeline dry-run executed against a staging
      D1 database** (a database that is neither the final production D1
      nor the POC's) using the real exported production data (once
      export is explicitly authorized), and `verify-migration.js` run
      against it with all checks passing.
- [ ] **10. Worker API smoke-tested against the staging D1** from step 9
      with real production-shaped data (not just the small local seed
      set) — at minimum: login (application + master), list/read on
      every business entity, one create/update per entity type.
- [ ] **11. Migration re-run against the real production D1** (the
      database from step 1, not staging) from a fresh production
      PostgreSQL export, and `verify-migration.js`-equivalent checks
      re-run against it.
- [ ] **12. Flutter `prod.json` reviewed and updated** to point at the
      new production Worker's URL. **Currently points at the POC**
      (`https://backend-d1-test.aryanlandmarksolutions.workers.dev/api/v1`
      — see the Phase 11 report) — this is a pre-existing discrepancy,
      not something this checklist created, and must be corrected as
      part of the real cutover, not before.
- [ ] **13. Rollback plan reviewed and signed off** by a human (see
      Backup & Rollback Runbook below) before cutover, including a
      concrete "how do we know it's broken and how fast can we revert"
      criterion.
- [ ] **14. Explicit human approval to cut traffic over** — this is the
      only box that authorizes stopping PostgreSQL from being the
      active production backend, and it comes last, after every other
      box is checked.

## Backup & Rollback Runbook

### Before migration begins

- Take a full `pg_dump` of the production PostgreSQL database and store
  it somewhere durable outside the application server (not merely
  another table/schema in the same database).
- Record the exact row counts for all 7 relevant tables
  (`users`, `properties`, `inquiries`, `inquiry_assignments`,
  `attachments`, `follow_ups`, `notifications` — `audit_logs` is
  informational and not authoritative for reconciliation) at backup
  time, so post-migration verification has a fixed baseline to compare
  against even if PostgreSQL keeps accepting writes during the window.
- Confirm the existing `aryan-landmark-backend` (Containers/NestJS)
  Worker is healthy and serving traffic normally — this is the fallback
  target for rollback, so it must not itself be mid-change.

### During migration

- Run the export → transform → import → verify pipeline exactly as
  tested locally in this phase, pointed at the real production
  PostgreSQL (read-only for export) and the real production D1
  (writes, `--remote`, only once explicitly authorized — this tooling
  currently has no code path that can do this; a production-targeting
  variant would need to be deliberately built and reviewed, not
  adapted from the `--local`-hardcoded scripts as-is).
- Do not point any client traffic at the new D1-backed Worker during
  this window — it is being populated, not yet serving.
- If `verify-migration.js`-equivalent checks fail against production
  data, stop before any cutover step and treat it as a blocker, not
  something to patch around under time pressure.

### After migration, before cutover

- Re-run full verification (row counts, PK sets, FK orphan checks,
  boolean fidelity, JSON round-trip, money round-trip — the same 38
  checks proven in Phase 10/11, generalized to real row counts) against
  the real production D1.
- Smoke-test the new Worker's APIs end-to-end with real credentials in
  a controlled way (not yet exposed to real users).
- Only after this passes does checklist item 14 become eligible.

### Rollback scenarios

- **Problem found before cutover** (verification fails, smoke tests
  fail): no rollback needed — PostgreSQL/NestJS is still the active
  backend and was never touched. Fix the migration tooling or wait for
  more data, and re-run steps 9-11 above from scratch (the pipeline is
  designed to be fully repeatable via `reset-d1.js` for exactly this
  reason).
- **Problem found shortly after cutover** (Flutter now points at the
  new Worker, but something is wrong): revert `prod.json`'s
  `API_BASE_URL` back to the previous backend's URL and get a new
  Flutter build out — this is the fastest rollback path and does not
  require touching any backend infrastructure. The old
  `aryan-landmark-backend` Worker must therefore be kept running
  (not decommissioned) for a defined grace period after cutover, so this
  path is actually available.
- **Data diverged after cutover** (writes happened against D1 that now
  need to be reconciled back if rolling back to PostgreSQL): out of
  scope for this phase's tooling — the export/transform/import pipeline
  is one-directional (PostgreSQL → D1). A D1 → PostgreSQL reverse-sync
  tool does not exist and would need to be built and tested before any
  rollback plan that assumes it, if the grace period is long enough for
  meaningful new writes to accumulate on D1.
