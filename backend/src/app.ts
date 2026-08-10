import type { OatDatabase } from '@oat/db';
import type { AssetStorage } from '@oat/types';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from './app-env.ts';
import type { Env } from './config/env.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { assetRoutes } from './routes/assets.ts';
import { updatesRoutes } from './routes/updates.ts';

export interface AppDependencies {
  env: Env;
  db: OatDatabase;
  storage: AssetStorage;
  logger?: Logger;
}

/**
 * Hono application composition.
 *
 * Middleware order is behaviour, not style: context injection first so
 * everything downstream can log, then the error boundary, then routes.
 */
export function createApp(deps: AppDependencies) {
  const logger = deps.logger ?? createLogger(deps.env.LOG_LEVEL);
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('env', deps.env);
    c.set('db', deps.db);
    c.set('storage', deps.storage);
    c.set('logger', logger.child({ requestId }));
    c.header('x-request-id', requestId);
    await next();
  });

  app.use('*', async (c, next) => {
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    await next();
  });

  app.onError((error, c) => {
    // Log the detail, return a generic body: internal messages can leak schema
    // and path information.
    c.var.logger.error('request_failed', {
      message: error.message,
      stack: error.stack,
      path: c.req.path,
    });
    return c.json({ code: 'INTERNAL', message: 'Internal server error' }, 500);
  });

  app.get('/health', async (c) => {
    const checks = { db: false, storage: false };

    try {
      await c.var.db.run(sql`SELECT 1`);
      checks.db = true;
    } catch {
      /* reported as false */
    }

    try {
      // A key that will never exist; we only care that the driver responds.
      await c.var.storage.exists('sha256/00/healthcheck');
      checks.storage = true;
    } catch {
      /* reported as false */
    }

    const ok = checks.db && checks.storage;
    return c.json({ ok, ...checks }, ok ? 200 : 503);
  });

  // Public Expo protocol surface.
  app.route('/api/v1/updates', updatesRoutes);
  app.route('/api/v1/assets', assetRoutes);

  return app;
}

export type OatApp = ReturnType<typeof createApp>;
