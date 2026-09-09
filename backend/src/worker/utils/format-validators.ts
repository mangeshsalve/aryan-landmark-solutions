// Phase 9 — byte-perfect replacements for the hand-written email/URL/
// ISO-8601 regex approximations flagged as known fidelity gaps in
// Phases 3-6. Empirical comparison against the real `validator` package
// (the exact library class-validator's @IsEmail()/@IsUrl()/@IsISO8601()
// delegate to, confirmed by reading class-validator's own decorator
// source: node_modules/class-validator/cjs/decorator/string/IsEmail.js
// etc.) found real, meaningful mismatches in both directions — the old
// hand-rolled regexes were sometimes too lenient (accepting
// "test@example.com.", "test@127.0.0.1", "javascript:alert(1)" as a
// valid mapUrl) and sometimes too strict (rejecting "example.com" as a
// mapUrl, since @IsUrl() doesn't require a protocol by default; rejecting
// ISO week-dates like "2026-W36-1").
//
// Rather than hand-reimplement validator.js's real logic (isEmail alone
// is ~170 lines covering RFC2822 quoting, IDN domains, gmail-specific
// rules, IP-literal domains, etc. — exactly the kind of thing this
// phase's instructions say not to manually reproduce), this imports the
// real `validator` package directly. It was already present in
// node_modules as class-validator's own dependency (confirmed via
// package-lock.json — class-validator declares "validator": "^13.15.22",
// resolved to 13.15.35) — Phase 9 only promotes it from transitive to a
// direct dependency in package.json; no new package was fetched or
// added to the dependency tree. The three specific submodules used here
// (isEmail, isURL, isISO8601, and their own transitive isFQDN/isIP/
// isByteLength/checkHost/merge/assertString helpers) are pure JS with no
// Node built-ins (verified by reading each file) — safe to bundle into
// the Workers runtime with no nodejs_compat flag.
//
// All three are called with zero options, matching every real DTO's
// usage exactly (`@IsEmail()`, `@IsUrl()`, `@IsISO8601()` are all called
// bare, with no options object, in login.dto.ts, create-customer.dto.ts,
// create-application-user.dto.ts, create-property.dto.ts, and
// create-follow-up.dto.ts — verified by direct read this phase).
import isEmailImpl from 'validator/lib/isEmail';
import isURLImpl from 'validator/lib/isURL';
import isISO8601Impl from 'validator/lib/isISO8601';

export function isValidEmail(value: string): boolean {
  return isEmailImpl(value);
}

export function isValidMapUrl(value: string): boolean {
  return isURLImpl(value);
}

export function isValidIso8601(value: string): boolean {
  return isISO8601Impl(value);
}

// Phase 22 — Reports date-range filters (fromDate/toDate). Deliberately
// NOT reusing isValidIso8601 above: that function exists to byte-match
// class-validator's lenient bare @IsISO8601() for an existing DTO field
// (follow-ups' scheduledAt), which — confirmed by direct read of that
// validator — accepts calendar-impossible dates like "2026-02-30". There
// is no existing fromDate/toDate field anywhere in the real backend to
// stay byte-compatible with (Phase 21 discovery confirmed zero report/
// date-range endpoints exist today), so this new, purpose-built
// validator is free to be stricter and simpler: a plain YYYY-MM-DD
// calendar date, real calendar validity enforced (rejects 2026-02-30
// rather than silently rolling it into March), no time component. A
// report date-range boundary should never be ambiguous about whether it
// includes a time-of-day, and letting an invalid calendar date reach
// getDateRangeBoundsUtc() below would silently roll over rather than
// fail clearly.
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateOnly(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}
