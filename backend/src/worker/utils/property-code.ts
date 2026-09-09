/**
 * Ported verbatim from src/properties/property-code.util.ts — still the
 * same flagged placeholder (no property-code format is defined in any
 * authoritative document; see that file's own doc comment and CLAUDE.md's
 * "Open decisions" section #1). Do not invent a different format here;
 * this must stay byte-for-byte identical to the real backend's generator.
 */
export function generatePropertyCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `PROP-${hex.toUpperCase()}`;
}
