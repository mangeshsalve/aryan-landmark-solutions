/**
 * D1/SQLite error-shape helpers, shared by every Phase 3+/4+ route that
 * writes to D1. D1 has no Prisma-style typed error codes (no P2002/P2003)
 * — these check for the exact message substrings SQLite/D1 actually
 * produces (empirically confirmed against a real local D1 database in
 * Phase 1's validation: "UNIQUE constraint failed: ..." and
 * "FOREIGN KEY constraint failed"). Only these specific, evidence-based
 * shapes are recognized; every other database error is left to propagate
 * as an unexpected/internal error rather than being guessed at.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

export function isForeignKeyConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('FOREIGN KEY constraint failed');
}
