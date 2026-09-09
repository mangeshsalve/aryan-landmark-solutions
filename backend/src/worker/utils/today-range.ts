/**
 * Ported verbatim from src/follow-ups/today-range.util.ts — "today"
 * boundaries for GET /follow-ups/today, fixed to IST (Asia/Kolkata,
 * UTC+5:30, no DST) per that file's documented flagged assumption (no
 * business timezone is defined anywhere in the authoritative docs). Both
 * bounds are real UTC instants (ISO-8601 strings, matching how every
 * timestamp is stored in this D1 schema), never a string-prefix
 * comparison — so `scheduled_at >= start AND scheduled_at < end` stays
 * correct against the TEXT-stored ISO-8601 timestamps, whose lexical
 * ordering equals chronological ordering for same-format UTC strings.
 */
const IST_OFFSET_MINUTES = 330; // Asia/Kolkata, fixed offset, no DST

export interface TodayRange {
  start: string;
  end: string;
}

export function getTodayRangeUtc(now: Date = new Date()): TodayRange {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const istMidnightAsUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );

  const start = new Date(istMidnightAsUtcMs - IST_OFFSET_MINUTES * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);

  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Phase 22 — generalizes getTodayRangeUtc() above from "now" to an
 * arbitrary caller-supplied YYYY-MM-DD (already validated via
 * isValidDateOnly() by the caller). Same IST_OFFSET_MINUTES, same
 * "UTC instant of 00:00 IST on that calendar date" math, just applied to
 * a given date instead of one derived from `new Date()` — this is
 * mathematically identical to getTodayRangeUtc()'s own derivation (see
 * that function: shifting `now` by the offset and reading its UTC-
 * labelled Y/M/D back out is exactly how you get the IST calendar date
 * of `now`; here the caller already hands us that calendar date
 * directly, so the shift step is unnecessary — only the final
 * `Date.UTC(y,m,d) - offset` step is needed).
 *
 * Report date-range filters are inclusive of both fromDate and toDate's
 * entire IST calendar day: `start` is 00:00:00.000 IST on fromDate;
 * `end` is the exclusive upper bound one IST calendar day past toDate
 * (i.e. 00:00:00.000 IST the day after toDate) — every report queries
 * `column >= start AND column < end`, the same half-open-interval
 * pattern getTodayRangeUtc() already uses, so a record timestamped
 * anywhere within toDate's IST calendar day is included, never
 * unintentionally excluded by an off-by-one at the boundary.
 */
export interface DateRangeBounds {
  start?: string;
  end?: string;
}

function istMidnightUtcIso(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const utcMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MINUTES * 60_000;
  return new Date(utcMs).toISOString();
}

export function getDateRangeBoundsUtc(fromDate?: string, toDate?: string): DateRangeBounds {
  const bounds: DateRangeBounds = {};
  if (fromDate) {
    bounds.start = istMidnightUtcIso(fromDate);
  }
  if (toDate) {
    const [year, month, day] = toDate.split('-').map(Number);
    // One IST calendar day past toDate, expressed the same way
    // getTodayRangeUtc() derives its own exclusive `end` (start + 24h) —
    // reusing istMidnightUtcIso on (day + 1) lets JS's own Date
    // month/year rollover handle end-of-month/year toDate values
    // correctly (e.g. toDate "2026-08-31" rolls to "2026-09-01" without
    // any special-casing here).
    const nextDayUtcMs = Date.UTC(year, month - 1, day + 1) - IST_OFFSET_MINUTES * 60_000;
    bounds.end = new Date(nextDayUtcMs).toISOString();
  }
  return bounds;
}
