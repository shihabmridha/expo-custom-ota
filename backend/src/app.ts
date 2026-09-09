import type { OtaDatabase } from '@ota/db';
import type { AssetStorage } from '@ota/types';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from './app-env.ts';
import type { Env } from './config/env.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { TrackingDiagnostics } from './lib/tracking-diagnostics.ts';
import { originCheck, requireAdmin } from './middleware/admin.ts';
import { serveSpa } from './middleware/spa.ts';
import { applicationRoutes } from './routes/admin/applications.ts';
import { createAuthRoutes } from './routes/admin/auth.ts';
import { channelRoutes } from './routes/admin/channels.ts';
import { deviceRoutes } from './routes/admin/devices.ts';
import { releaseRoutes } from './routes/admin/releases.ts';
import { assetRoutes } from './routes/assets.ts';
import { updatesRoutes } from './routes/updates.ts';
import { ApplicationError } from './services/applications.ts';
import { ImportError } from './services/import/importer.ts';
import { PublishError } from './services/publishing.ts';
import { SigningService } from './services/signing.ts';

export interface AppDependencies {
  env: Env;
  db: OtaDatabase;
  storage: AssetStorage;
  logger?: Logger;
}

/**
 * Hono application composition.
 *
 * Middleware order is behaviour, not style: context injection first so
 * everything downstream can log, then security headers, then the error
 * boundary, then routes. Admin routes get the Origin check before the session
 * check so a cross-site request is rejected without touching the database.
 */
export function createApp(deps: AppDependencies) {
  const logger = deps.logger ?? createLogger(deps.env.LOG_LEVEL);

  // Built once per app rather than per request: its signer cache only pays off
  // if it outlives a request, and the no-update path signs a directive on every
  // device poll. Key rotation invalidates the affected entry explicitly.
  const signing = new SigningService(deps.db, deps.env.signingKeysDirAbsolute);

  const app = new Hono<AppEnv>();
  const trackingDiagnostics = new TrackingDiagnostics(logger);

  const allowedOrigins = [deps.env.OTA_PUBLIC_URL];

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('env', deps.env);
    c.set('db', deps.db);
    c.set('trackingDiagnostics', trackingDiagnostics);
    c.set('storage', deps.storage);
    c.set('signing', signing);
    c.set('logger', logger.child({ requestId }));
    c.header('x-request-id', requestId);
    await next();
  });

  app.use('*', async (c, next) => {
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    await next();
  });

  app.onError((error, c) => {
    // Domain errors carry a safe, actionable message; anything else is logged
    // in full and reported generically, since internal messages leak schema and
    // path detail.
    if (error instanceof ApplicationError) {
      return c.json({ code: error.code, message: error.message }, error.status as 400);
    }
    if (error instanceof ImportError) {
      return c.json({ code: error.code, message: error.message }, 422);
    }
    if (error instanceof PublishError) {
      return c.json({ code: error.code, message: error.message }, 409);
    }

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

  // Admin surface. `/auth` is mounted before the session guard so login and the
  // session probe are reachable while signed out.
  app.use(
    '/api/admin/*',
    originCheck({ allowed: allowedOrigins, devLoose: !deps.env.isProduction }),
  );
  app.route('/api/admin/auth', createAuthRoutes());

  app.use('/api/admin/*', requireAdmin);
  app.route('/api/admin/applications', applicationRoutes);
  app.route('/api/admin/channels', channelRoutes);
  app.route('/api/admin', releaseRoutes);
  app.route('/api/admin', deviceRoutes);

  // The built dashboard, mounted last so it only handles what the API did not.
  if (deps.env.DASHBOARD_DIST) {
    app.use('*', serveSpa(deps.env.DASHBOARD_DIST));
  }

  return app;
}

export type OtaApp = ReturnType<typeof createApp>;
