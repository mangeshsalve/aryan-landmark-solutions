import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { ok } from '../utils/response';

/**
 * GET /health — Step 12. Infrastructure verification only: confirms the
 * Worker is running and the D1 binding is actually reachable via a real
 * query, mirroring src/health/prisma.health.ts's own reasoning ("a
 * process that's alive but can't reach the database is not actually
 * healthy"). No business logic, no other tables touched.
 */
export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', async (c) => {
  const result = await c.env.DB.prepare('SELECT 1 AS healthy').first();
  return c.json(ok({ status: 'ok', database: result }));
});
