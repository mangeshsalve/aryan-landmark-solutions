/**
 * Phase 16A Part 7 — "today" boundaries for GET /follow-ups/today.
 *
 * FLAGGED ASSUMPTION: this project has no documented business timezone
 * anywhere (no TZ env var, nothing in database-design.md or
 * api-conventions.md). Every DateTime column is TIMESTAMPTZ (an absolute
 * instant, timezone-agnostic in storage), and the Node process's own
 * local timezone is not a reliable signal — it varies by deployment host
 * (this dev machine happens to be IST; a production container commonly
 * defaults to UTC). Since this is an India-only real-estate business
 * (INR pricing, Indian addresses/pincodes throughout the schema), IST
 * (Asia/Kolkata, UTC+5:30, no DST) is used here as the explicit business
 * timezone for "today" — a one-constant change if that's ever wrong.
 *
 * This is NOT inferred from `new Date()`/the process timezone, and NOT
 * an arbitrary string-prefix comparison on scheduled_at — both bounds
 * below are real UTC instants, so the caller can use a normal indexed
 * range query: scheduledAt >= start AND scheduledAt < end.
 */
const IST_OFFSET_MINUTES = 330; // Asia/Kolkata, fixed offset, no DST

export interface TodayRange {
  start: Date;
  end: Date;
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

  return { start, end };
}
