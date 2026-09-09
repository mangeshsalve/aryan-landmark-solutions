import { Hono } from 'hono';
import type { AppEnv, Bindings } from './types/bindings';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './middleware/error';
import { runFollowUpReminderSweep } from './scheduled/follow-up-reminders';
import { runInquiryVerificationReaper } from './scheduled/inquiry-verification-reaper';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { usersRoutes } from './routes/users';
import { masterUsersRoutes } from './routes/master-users';
import { customersRoutes } from './routes/customers';
import { propertiesRoutes } from './routes/properties';
import { attachmentsRoutes } from './routes/attachments';
import { inquiriesRoutes } from './routes/inquiries';
import { followUpsRoutes } from './routes/follow-ups';
import { notificationsRoutes } from './routes/notifications';
import { publicPropertiesRoutes } from './routes/public-properties';
import { publicInquiriesRoutes } from './routes/public-inquiries';
import { reportsRoutes } from './routes/reports';
import { syncRoutes } from './routes/sync';

/**
 * Worker entry point — Phase 2 (infrastructure only). Composes
 * middleware and routes; no business logic lives here (Step 3).
 *
 * Same path prefix as the existing NestJS backend
 * (app.setGlobalPrefix('api/v1') in src/main.ts), so a future Flutter
 * cutover needs no path changes beyond the base URL — matching Step 5's
 * "preserve the existing API contract" requirement even at this
 * infrastructure stage.
 *
 * This file coexists with, and does not replace, src/main.ts /
 * src/app.module.ts — the NestJS application remains the one actually
 * running in production during this migration. Nothing in this tree is
 * wired into the NestJS build (see tsconfig.worker.json / the "worker:*"
 * npm scripts in package.json), so this file has zero effect on
 * `npm run build`/`npm run start:prod`.
 */
const app = new Hono<AppEnv>();

app.use('*', requestIdMiddleware);

const api = new Hono<AppEnv>();
api.route('/', healthRoutes);
api.route('/', authRoutes);
api.route('/', usersRoutes);
api.route('/', masterUsersRoutes);
api.route('/', customersRoutes);
api.route('/', propertiesRoutes);
api.route('/', attachmentsRoutes);
api.route('/', inquiriesRoutes);
api.route('/', followUpsRoutes);
api.route('/', notificationsRoutes);
api.route('/', publicPropertiesRoutes);
api.route('/', publicInquiriesRoutes);
api.route('/', reportsRoutes);
api.route('/', syncRoutes);
// Phase 22 added reportsRoutes, Phase 33 added syncRoutes. Any future
// module is added here the same way, one at a time, per the "inspect
// first, preserve the existing contract" discipline every phase has
// followed.

app.route('/api/v1', api);
app.onError(errorHandler);
app.notFound(notFoundHandler);

/**
 * Phase 38D — adds the Cron-triggered `scheduled()` export alongside
 * the existing HTTP `fetch` export. `app.fetch` is passed through
 * unchanged (Hono's fetch signature already matches the Workers
 * `fetch(request, env, ctx)` module-worker contract exactly), so every
 * existing HTTP route/behavior is untouched by this addition — only a
 * second export key is added, nothing about `app` itself changes.
 *
 * `ctx.waitUntil` ensures the sweep is allowed to finish even though
 * `scheduled()` itself returns before the awaited work necessarily
 * completes — the standard Workers pattern for scheduled handlers that
 * do async work, not something specific to this feature.
 *
 * Phase 39 (recording-enforcement fix) added a second sweep,
 * `runInquiryVerificationReaper`, on the same Cron Trigger/schedule —
 * no new scheduling system, per that phase's explicit instruction. The
 * two sweeps touch unrelated tables (follow_ups vs. inquiries) with no
 * shared row-level contention, so they run concurrently rather than one
 * waiting on the other.
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([runFollowUpReminderSweep(env), runInquiryVerificationReaper(env)]).then(
        () => undefined,
      ),
    );
  },
};
