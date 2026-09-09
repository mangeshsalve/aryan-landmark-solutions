-- =====================================================================
-- Phase 41C — adds device_tokens, the table backing FCM push-notification
-- delivery (src/worker/utils/fcm.ts, wired into
-- routes/inquiries.ts's createInquiryAssignedNotification). Additive
-- only: no existing table/column is touched.
--
-- One row per physical device registration, keyed by the FCM
-- registration token itself (globally unique — see uq_device_tokens_token
-- below), not by user. This is deliberate: the same physical device can
-- later be logged into by a different employee (shared/handed-down
-- devices), so `token` is the true identity and `user_id` is reassigned
-- (transferred) to whichever application user most recently registered
-- it from POST /notifications/device-token, rather than a device being
-- permanently tied to the first user who ever registered it.
--
-- `is_active` (soft state, not physical deletion) drives two independent
-- lifecycles:
--  - DELETE /notifications/device-token sets is_active = 0 for the
--    caller's own token (logout / opt-out) — matches this project's
--    existing soft-delete-by-flag conventions (e.g. inquiries.is_public,
--    users.status) rather than physically removing rows.
--  - The FCM send path (utils/fcm.ts) sets is_active = 0 when Google
--    reports a token as permanently UNREGISTERED, so a since-uninstalled
--    app is never retried indefinitely. Temporary/transient FCM errors
--    never touch is_active — see that file's own comments.
--
-- ON DELETE CASCADE on user_id: a deleted user's device tokens are
-- meaningless (nothing to notify), so they're removed automatically,
-- the same FK-cascade shape already used by notifications.user_id.
-- =====================================================================

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ANDROID','IOS')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_device_tokens_token
  ON device_tokens (token);

CREATE INDEX idx_device_tokens_user_active
  ON device_tokens (user_id, is_active);
