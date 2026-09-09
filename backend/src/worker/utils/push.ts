import type { Bindings } from '../types/bindings';
import { sendFcmPush, isFcmConfigured, FcmNotConfiguredError } from './fcm';

/**
 * Phase 41F — the one shared "look up a user's active device tokens and
 * attempt an FCM push" orchestration, extracted out of
 * routes/inquiries.ts's original inquiry-assignment-only
 * sendInquiryAssignedPush so routes/inquiries.ts and
 * scheduled/follow-up-reminders.ts can both call the exact same logic
 * instead of each having their own copy. utils/fcm.ts itself is
 * untouched by this phase — this file only orchestrates D1 lookups
 * around it (user status, device_tokens), it does not re-implement any
 * Google/FCM API mechanics.
 *
 * Behavior (byte-for-byte the same as the original inquiry-assignment
 * implementation, generalized only by taking entityType/entityId/
 * logContext as parameters instead of hardcoding them):
 *  - Re-checks the recipient's *current* status (must still exist, must
 *    be ACTIVE) immediately before sending, not just at the time the
 *    triggering event happened.
 *  - Only is_active=1 tokens are ever selected.
 *  - Never throws — every failure (missing FCM config, a bad token, an
 *    unexpected exception) is caught and logged inside this function,
 *    so a caller can always safely `await` this after its own write has
 *    already committed, exactly like the original.
 *  - A permanently-invalid token (per utils/fcm.ts's classification) is
 *    deactivated; a temporary failure is logged only, token untouched;
 *    a successful send is logged for observability (a gap the original
 *    inquiry-assignment implementation had — this closes it for both
 *    callers).
 *  - The device token value itself is never logged, only
 *    device_tokens.id.
 */
export interface SendPushToUserParams {
  userId: string;
  notificationId: string;
  entityType: string;
  entityId: string;
  title: string;
  message: string;
  /** Distinguishes log lines by trigger source (e.g. "Inquiry-assigned push", "Follow-up reminder push") without changing the rest of the log shape. */
  logContext: string;
}

export async function sendPushToUser(env: Bindings, params: SendPushToUserParams): Promise<void> {
  const { userId, notificationId, entityType, entityId, title, message, logContext } = params;

  try {
    const user = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
      .bind(userId)
      .first<{ status: string }>();
    if (!user || user.status !== 'ACTIVE') return;

    const tokens = await env.DB.prepare(
      'SELECT id, token FROM device_tokens WHERE user_id = ? AND is_active = 1',
    )
      .bind(userId)
      .all<{ id: string; token: string }>();
    const targets = tokens.results ?? [];
    if (targets.length === 0) return;

    if (!isFcmConfigured(env)) {
      console.error(`${logContext}: FCM is not configured, skipping`, {
        userId,
        notificationId,
        targetTokenCount: targets.length,
      });
      return;
    }

    console.log(`${logContext}: sending`, {
      userId,
      notificationId,
      targetTokenCount: targets.length,
    });

    for (const target of targets) {
      try {
        const result = await sendFcmPush(env, {
          token: target.token,
          title,
          body: message,
          data: { notificationId, entityType, entityId, title, message },
        });

        if (result.outcome === 'SENT') {
          console.log(`${logContext}: sent`, {
            userId,
            notificationId,
            deviceTokenId: target.id,
          });
        } else if (result.outcome === 'INVALID_TOKEN') {
          console.log(`${logContext}: deactivating permanently invalid token`, {
            userId,
            notificationId,
            deviceTokenId: target.id,
            reason: result.reason,
          });
          await env.DB.prepare('UPDATE device_tokens SET is_active = 0 WHERE id = ?')
            .bind(target.id)
            .run();
        } else {
          console.error(`${logContext}: temporary FCM failure`, {
            userId,
            notificationId,
            deviceTokenId: target.id,
            reason: result.reason,
          });
        }
      } catch (error) {
        // A single token's failure must never stop the others from
        // being attempted.
        console.error(`${logContext}: unexpected error sending to one token`, {
          userId,
          notificationId,
          deviceTokenId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    if (error instanceof FcmNotConfiguredError) {
      console.error(`${logContext}: FCM is not configured, skipping`, {
        userId,
        notificationId,
      });
      return;
    }
    console.error(`${logContext}: failed`, {
      userId,
      notificationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
