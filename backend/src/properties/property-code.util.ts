import { randomBytes } from 'crypto';

/**
 * PLACEHOLDER — no property-code generation strategy is defined anywhere
 * in the authoritative documents (checked database-design.md,
 * business-requirements.md, api-conventions.md,
 * greenfield-implementation-plan.md). propertyCode is optional in
 * CreatePropertyRequest but NOT NULL UNIQUE in schema.sql, so something
 * must generate one when the client doesn't supply it.
 *
 * This generates `PROP-` followed by 8 random uppercase hex characters
 * (~4 billion possibilities — collisions are checked and retried by the
 * caller regardless). Deliberately simple per instructions; report this
 * decision for review rather than treat it as final business logic.
 */
export function generatePropertyCode(): string {
  return `PROP-${randomBytes(4).toString('hex').toUpperCase()}`;
}
