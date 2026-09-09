'use strict';

/**
 * Safety gate for scripts/production/ — deliberately a SEPARATE gate from
 * scripts/migration/lib/safety.js's production functions, with its own
 * env var names, even though the shape (explicit opt-in + exact-phrase
 * confirmation + independent D1-name re-confirmation) is intentionally
 * "similar to the existing production tooling safety gates" per this
 * phase's instructions. Kept separate on purpose: this script performs a
 * conceptually different action (one-time initial-data seeding) from a
 * full PostgreSQL migration, and a human should have to opt into each
 * independently — setting one should never accidentally authorize the
 * other.
 */
const PRODUCTION_SEED_CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION_D1';
const PRODUCTION_D1_DATABASE_NAME = 'aryan-landmark-production';
const PRODUCTION_WRANGLER_CONFIG = 'wrangler.production.jsonc';

function assertProductionSeedAllowed(scriptName) {
  if (process.env.ALLOW_PRODUCTION_SEED !== 'true') {
    console.error(`[safety] Refusing to run ${scriptName}: set ALLOW_PRODUCTION_SEED=true.`);
    process.exit(1);
  }
  if (process.env.PRODUCTION_SEED_CONFIRM !== PRODUCTION_SEED_CONFIRM_PHRASE) {
    console.error(
      `[safety] Refusing to run ${scriptName}: set PRODUCTION_SEED_CONFIRM=${PRODUCTION_SEED_CONFIRM_PHRASE} ` +
        'as an exact-phrase, deliberate confirmation that this run is intentionally writing to production D1.',
    );
    process.exit(1);
  }
  if (process.env.D1_PRODUCTION_DATABASE_NAME !== PRODUCTION_D1_DATABASE_NAME) {
    console.error(
      `[safety] Refusing to run ${scriptName}: set D1_PRODUCTION_DATABASE_NAME=${PRODUCTION_D1_DATABASE_NAME} ` +
        'as an explicit, exact-match confirmation of the intended target, independent of whatever ' +
        `${PRODUCTION_WRANGLER_CONFIG} currently contains.`,
    );
    process.exit(1);
  }
  console.log(`[safety] REAL PRODUCTION — ${scriptName} will access D1 database "${PRODUCTION_D1_DATABASE_NAME}" via --config ${PRODUCTION_WRANGLER_CONFIG} --remote.`);
}

module.exports = { assertProductionSeedAllowed, PRODUCTION_D1_DATABASE_NAME, PRODUCTION_WRANGLER_CONFIG, PRODUCTION_SEED_CONFIRM_PHRASE };
