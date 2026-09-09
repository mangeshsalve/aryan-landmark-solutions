import type { Bindings } from '../types/bindings';
import { nowIso } from '../utils/id';

/**
 * Phase 39 (recording-enforcement fix + reconciliation follow-up) — the
 * non-destructive reconciliation sweep for ADMIN inquiries whose Group
 * A/B finalization never completed, invoked from index.ts's
 * `scheduled()` handler on the same 5-minute Cron Trigger as the
 * Phase 38D follow-up reminder sweep (no new scheduling system
 * introduced).
 *
 * Background: POST /inquiries can only verify Group A's employee half
 * synchronously (a RECORDING attachment can't exist before the inquiry
 * row does), so an ADMIN Group-A-only inquiry is created with
 * `submitted_at = NULL` and is expected to be finalized shortly after by
 * POST /inquiries/:inquiryId/submit, once the recording upload
 * completes. Two distinct failure shapes follow from this:
 *
 *   1. The recording upload itself never succeeds (or the app is closed
 *      mid-flow, or a direct API caller never finalizes at all) — the
 *      inquiry is genuinely incomplete. If this persists 24+ hours, it
 *      is FLAGGED (`verification_failed_at` set) — visibility only,
 *      never destructive.
 *   2. The recording upload succeeds but the finalize (`/submit`) HTTP
 *      request itself fails transiently, or is simply never retried —
 *      Group A is actually complete, but `submitted_at` stays NULL
 *      forever with nothing to prompt a retry (the Flutter detail
 *      screen won't even offer "Add Recording" again, since one already
 *      exists). This sweep now REPAIRS this case directly: it finalizes
 *      the inquiry itself, exactly as `/submit` would have, the moment
 *      it notices Group A or B is genuinely complete — regardless of
 *      the inquiry's age and regardless of whether it was previously
 *      flagged.
 *
 * This sweep therefore performs two functions every run:
 *   A. Repair — any eligible unfinalized inquiry that is now genuinely
 *      valid (Group A or B complete) is finalized immediately, and any
 *      prior `verification_failed_at` flag is cleared. No age gate: a
 *      just-created inquiry that already satisfies Group A/B (e.g. the
 *      recording finished uploading a second ago but the finalize call
 *      itself failed) is repaired right away, not after 24 hours.
 *   B. Flag — an eligible unfinalized inquiry that is still genuinely
 *      incomplete (neither group holds) is flagged only once it is 24+
 *      hours old, and only if not already flagged.
 *
 * Explicitly non-destructive in both directions, per the approved
 * design: never deletes the inquiry, never deletes attachments, never
 * touches `status`, never touches customer/property relationships,
 * never touches `updated_at`/`updated_by` (each UPDATE below sets only
 * `submitted_at`+`verification_failed_at`, or `verification_failed_at`
 * alone). `verification_failed_at` is a purely internal, non-public
 * column (migration 0005_add_inquiry_verification_failed_at.sql) never
 * exposed via INQUIRY_COLUMNS/toPublicInquiry()/the detail response/
 * `/sync/inquiries`/any report.
 *
 * Cutover scoping (critical): `inquiries.submitted_at` has been NULL for
 * every EMPLOYEE-created inquiry and every pre-existing ADMIN inquiry
 * long before this fix existed — it is NOT a safe signal on its own to
 * decide "created under the new rule". This sweep is therefore also
 * scoped to (a) `created_by` whose CURRENT role is ADMIN (the same
 * live-role-check philosophy this codebase uses everywhere else — there
 * is no historical role tracking anywhere in this schema), and (b)
 * `created_at >= PHASE_39_CUTOVER`, a hardcoded constant, so this sweep
 * can never evaluate, let alone touch, any inquiry that predates this
 * fix — this applies equally to the repair function, not just the flag
 * function. PHASE_39_CUTOVER below is still a placeholder, not the real
 * deployment timestamp — see the TODO on its declaration. It must be
 * updated before deploying, and must never be silently replaced with
 * "now" as part of a non-deployment change.
 *
 * Idempotency:
 *   - Repair: the finalize UPDATE is conditioned on `submitted_at IS
 *     NULL`, so an already-finalized inquiry is never re-touched even if
 *     selected again by an overlapping/later sweep.
 *   - Flag: a row already carrying `verification_failed_at` is detected
 *     in JS (from the same SELECT) and skipped entirely — its timestamp
 *     is never overwritten by a later sweep just because it's still
 *     incomplete. The flagging UPDATE additionally guards with
 *     `verification_failed_at IS NULL` as a defensive backstop.
 *   - Neither mutation has an external side effect (no notification, no
 *     email, nothing outside this one row), so unlike Phase 38D's
 *     notification-creation sweep, no claim/lock pattern is needed here
 *     — the WHERE-guarded conditional UPDATEs are sufficient on their
 *     own even under a rare overlapping invocation.
 */

// Phase 39 recording-enforcement-fix production deployment cutover —
// set to the actual UTC instant of this deployment. Never move this
// earlier without re-verifying no pre-existing inquiry could be
// captured.
const PHASE_39_CUTOVER = '2026-09-06T04:51:00.000Z';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

interface UnfinalizedInquiryCandidateRow {
  id: string;
  property_id: string | null;
  property_type: string | null;
  created_at: string;
  verification_failed_at: string | null;
  recording_count: number;
}

export async function runInquiryVerificationReaper(env: Bindings): Promise<void> {
  const nowMs = Date.now();

  // Deliberately no age filter and no verification_failed_at filter in
  // this query — both the repair function (age-independent) and the
  // flag function (age-gated, and must skip already-flagged rows) need
  // to see every eligible unfinalized row and decide per-row below,
  // rather than SQL pre-filtering one function's candidates out of the
  // other's view.
  const candidates = await env.DB.prepare(
    `SELECT i.id, i.property_id, p.property_type, i.created_at, i.verification_failed_at,
            (SELECT COUNT(*) FROM attachments a WHERE a.inquiry_id = i.id AND a.attachment_type = 'RECORDING') AS recording_count
     FROM inquiries i
     JOIN users u ON u.id = i.created_by
     LEFT JOIN properties p ON p.id = i.property_id
     WHERE u.role = 'ADMIN'
       AND i.created_at >= ?
       AND i.submitted_at IS NULL
       AND i.assigned_to_user_id IS NOT NULL`,
  )
    .bind(PHASE_39_CUTOVER)
    .all<UnfinalizedInquiryCandidateRow>();

  const rows = candidates.results ?? [];
  let repaired = 0;
  let flagged = 0;

  for (const row of rows) {
    // assigned_to_user_id IS NOT NULL is already guaranteed by the query
    // above, so Group A's completeness here reduces to "does a RECORDING
    // attachment actually exist".
    const groupAComplete = row.recording_count > 0;
    const groupBComplete = Boolean(
      row.property_id && row.property_type && row.property_type.trim().length > 0,
    );

    if (groupAComplete || groupBComplete) {
      // Repair — genuinely valid, just never finalized (recording
      // uploaded but /submit missed or failed, or a property/type was
      // corrected after the fact). Finalize exactly as /submit would,
      // clearing any prior flag, regardless of age.
      try {
        const finalizedAt = nowIso();
        const result = await env.DB.prepare(
          'UPDATE inquiries SET submitted_at = ?, verification_failed_at = NULL WHERE id = ? AND submitted_at IS NULL',
        )
          .bind(finalizedAt, row.id)
          .run();
        if (result.meta.changes) {
          repaired++;
          console.log('Inquiry verification reconciliation repaired (finalized)', {
            inquiryId: row.id,
          });
        }
      } catch (err) {
        console.error('Inquiry verification reconciliation failed to repair a candidate', {
          inquiryId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Still genuinely incomplete. Only flag once 24+ hours old, and
    // only if not already flagged — re-flagging on every 5-minute sweep
    // would repeatedly overwrite the timestamp for no benefit.
    const ageMs = nowMs - Date.parse(row.created_at);
    if (ageMs < GRACE_PERIOD_MS) continue;
    if (row.verification_failed_at !== null) continue;

    const reason = row.property_id
      ? 'no RECORDING attachment; linked property has no property type set'
      : 'no RECORDING attachment and no linked property';

    try {
      const flaggedAt = nowIso();
      const result = await env.DB.prepare(
        'UPDATE inquiries SET verification_failed_at = ? WHERE id = ? AND verification_failed_at IS NULL AND submitted_at IS NULL',
      )
        .bind(flaggedAt, row.id)
        .run();
      if (result.meta.changes) {
        flagged++;
        // Deliberately logs only the inquiry id and a structural reason
        // — never recording contents, never any attachment data, never
        // customer/employee PII.
        console.log('Inquiry verification reconciliation flagged', { inquiryId: row.id, reason });
      }
    } catch (err) {
      console.error('Inquiry verification reconciliation failed to flag a candidate', {
        inquiryId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('Inquiry verification reconciliation sweep complete', {
    candidates: rows.length,
    repaired,
    flagged,
  });
}
