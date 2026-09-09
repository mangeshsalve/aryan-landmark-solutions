import type { Bindings } from '../types/bindings';
import { createNotification } from '../routes/notifications';
import { sendPushToUser } from '../utils/push';
import { nowIso } from '../utils/id';

/**
 * Phase 38D — the follow-up reminder sweep, invoked from index.ts's
 * `scheduled()` handler on a 5-minute Cron Trigger (see
 * wrangler.production.jsonc's `triggers.crons`). Not an HTTP route —
 * there is no new endpoint here, per this phase's explicit scope.
 *
 * Due-follow-up query joins to `inquiries` (qualified `f.`/`i.` aliases,
 * same discipline as every other JOIN in this codebase once a column
 * name could be ambiguous — `status`/`id` both exist on `follow_ups`
 * and `inquiries`). A follow-up is eligible when:
 *   - f.status = 'PENDING'                    (not COMPLETED)
 *   - f.reminder_enabled = 1
 *   - f.scheduled_at <= now                    (due — plain UTC-instant
 *                                                comparison; scheduled_at
 *                                                is already a precise
 *                                                ISO-8601 UTC string, so
 *                                                no IST/timezone math is
 *                                                needed here at all)
 *   - f.reminder_sent_at IS NULL               (not already reminded)
 *   - i.assigned_to_user_id IS NOT NULL        (someone to notify)
 * A due follow-up whose parent inquiry has no assignee is excluded by
 * the query itself — skipped silently, never notified to anyone else
 * (no ADMIN/MASTER fallback recipient), matching this phase's explicit
 * decision.
 *
 * Concurrency / idempotency (Phase 38D item 13): Cloudflare Cron
 * Triggers are not guaranteed to never overlap, so this deliberately
 * does NOT rely solely on the initial SELECT's `reminder_sent_at IS
 * NULL` filter — two overlapping invocations could both read that same
 * NULL state before either writes. Instead, each candidate is first
 * *claimed* with a single conditional UPDATE
 * (`... WHERE id = ? AND reminder_sent_at IS NULL`), exactly the same
 * meta.changes-checked conditional-write idiom already used elsewhere
 * in this codebase (see routes/inquiries.ts's conditionalPredicate/
 * resolveConditionalWriteFailure) — SQLite/D1 serializes writes to a
 * single row, so at most one concurrent invocation can ever see
 * `meta.changes === 1` for the same follow-up; every other invocation
 * sees 0 and skips it as already-claimed, not as an error.
 *
 * This means the claim is written *before* the notification is created
 * — a deliberate, reasoned reordering of Phase 38D item 12's literal
 * "create the notification first, then mark" sequence, because there is
 * no way to make "notify-then-mark" atomic across overlapping
 * invocations without new infrastructure (a lock service, a unique
 * constraint on notifications, etc.), which item 13 explicitly rules
 * out. The failure-handling *intent* of item 12 is preserved exactly:
 * if createNotification() throws after a successful claim, the claim is
 * rolled back (reminder_sent_at reset to NULL) in the same catch block,
 * so the end state for a failed notification is indistinguishable from
 * "never claimed" — a later sweep retries it. Flagged here explicitly
 * as a decision worth revisiting if a simpler, literal notify-then-mark
 * order is preferred over airtight overlap-safety.
 *
 * One bad record must not abort the sweep: each candidate is processed
 * in its own try/catch, sequentially (not Promise.all — a 5-minute
 * cadence over what should be a small working set doesn't need
 * concurrent D1 writes, and sequential processing is easier to reason
 * about safely). Errors are logged via console.error (this Worker's
 * only server-side logging mechanism — see middleware/error.ts) with no
 * password/token/secret/PII beyond the follow-up/inquiry ids already
 * public within this system.
 *
 * Phase 41F: once the notification row above successfully commits, this
 * also sends an FCM push to the assigned employee via utils/push.ts's
 * sendPushToUser — the exact same shared token-lookup/send helper the
 * inquiry-assignment push path uses (no second, independent FCM
 * implementation). Because the push call only ever happens *after*
 * `sent++`/the notification-created log below, and sendPushToUser never
 * rejects, a push failure can never be mistaken for a
 * createNotification() failure and can never trigger the
 * reminder_sent_at rollback above — exactly the same isolation guarantee
 * the inquiry-assignment path already has.
 */

interface DueFollowUpRow {
  id: string;
  inquiry_id: string;
  inquiry_number: string;
  assigned_to_user_id: string;
}

export async function runFollowUpReminderSweep(env: Bindings): Promise<void> {
  const now = nowIso();

  const due = await env.DB.prepare(
    `SELECT f.id, f.inquiry_id, i.inquiry_number, i.assigned_to_user_id
     FROM follow_ups f
     JOIN inquiries i ON i.id = f.inquiry_id
     WHERE f.status = 'PENDING'
       AND f.reminder_enabled = 1
       AND f.scheduled_at <= ?
       AND f.reminder_sent_at IS NULL
       AND i.assigned_to_user_id IS NOT NULL`,
  )
    .bind(now)
    .all<DueFollowUpRow>();

  const candidates = due.results ?? [];
  let sent = 0;
  let alreadyClaimed = 0;
  let failed = 0;

  for (const row of candidates) {
    console.log('Follow-up reminder: candidate found', {
      followUpId: row.id,
      inquiryId: row.inquiry_id,
    });

    let claimed = false;
    try {
      const claim = await env.DB.prepare(
        'UPDATE follow_ups SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL',
      )
        .bind(now, row.id)
        .run();

      if (!claim.meta.changes) {
        // Another invocation (concurrent or a prior sweep) already
        // claimed this follow-up — not an error, nothing left to do.
        alreadyClaimed++;
        continue;
      }
      claimed = true;
      console.log('Follow-up reminder: claimed', {
        followUpId: row.id,
        inquiryId: row.inquiry_id,
      });

      const title = 'Follow-up reminder';
      const message = `Follow-up for inquiry ${row.inquiry_number} is due.`;

      // entityType/entityId deliberately point at the INQUIRY, not the
      // follow-up itself — matches the existing Flutter notification
      // tap-navigation contract (it only recognizes entityType=INQUIRY,
      // see INQUIRY_ASSIGNED's identical entityType/entityId shape), so
      // tapping this notification (or its push) opens the relevant
      // Inquiry Detail screen. The notification `type` stays
      // 'FOLLOW_UP_REMINDER' — only the entity reference changes.
      const notificationId = await createNotification(env.DB, {
        userId: row.assigned_to_user_id,
        type: 'FOLLOW_UP_REMINDER',
        title,
        message,
        entityType: 'INQUIRY',
        entityId: row.inquiry_id,
      });
      sent++;
      console.log('Follow-up reminder: notification created', {
        followUpId: row.id,
        inquiryId: row.inquiry_id,
        notificationId,
      });

      // Phase 41F — reuses the exact same token-lookup/FCM-send helper
      // as inquiry-assignment push (utils/push.ts's sendPushToUser),
      // rather than a second independent FCM implementation.
      // sendPushToUser never rejects (every failure inside it is caught
      // and logged), but this call is still wrapped in its own try/catch
      // as a defensive backstop: nothing here may ever be mistaken for a
      // createNotification() failure by the outer catch below, which
      // would incorrectly roll back reminder_sent_at and risk a
      // duplicate FOLLOW_UP_REMINDER notification on a later sweep once
      // the notification row above has already committed.
      try {
        await sendPushToUser(env, {
          userId: row.assigned_to_user_id,
          notificationId,
          entityType: 'INQUIRY',
          entityId: row.inquiry_id,
          title,
          message,
          logContext: 'Follow-up reminder push',
        });
      } catch (pushErr) {
        console.error('Follow-up reminder push: unexpected error outside sendPushToUser', {
          followUpId: row.id,
          inquiryId: row.inquiry_id,
          notificationId,
          error: pushErr instanceof Error ? pushErr.message : String(pushErr),
        });
      }
    } catch (err) {
      failed++;
      console.error('Follow-up reminder failed', {
        followUpId: row.id,
        inquiryId: row.inquiry_id,
        error: err instanceof Error ? err.message : String(err),
      });

      if (claimed) {
        // The claim succeeded but createNotification() threw — roll
        // back so this follow-up is retried on a later sweep, per
        // Phase 38D item 12's explicit failure-handling requirement.
        try {
          await env.DB.prepare('UPDATE follow_ups SET reminder_sent_at = NULL WHERE id = ?')
            .bind(row.id)
            .run();
        } catch (rollbackErr) {
          console.error('Follow-up reminder rollback failed', {
            followUpId: row.id,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
      }
    }
  }

  console.log('Follow-up reminder sweep complete', {
    candidates: candidates.length,
    sent,
    alreadyClaimed,
    failed,
  });
}
