import { contracts } from '@ota/contracts';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../../app-env.ts';
import { hashClientIp, resolveClientIp } from '../../lib/client-ip.ts';
import { RateLimiter } from '../../lib/rate-limit.ts';
import {
  createSession,
  destroySession,
  resolveSession,
  SESSION_COOKIE,
  verifyCredentials,
} from '../../services/auth.ts';
import { handle } from './validate.ts';

/**
 * Auth routes.
 *
 * Built as a factory so the login rate limiter belongs to one app instance
 * rather than the module. Module-level state would be shared between every app
 * created in a process — which makes it untestable and, more importantly, means
 * two servers in one process would share a limiter.
 */
export function createAuthRoutes() {
  // Five attempts per 15 minutes per IP+email. Mandatory rather than defensive:
  // argon2id costs ~100 ms of CPU per verify, so an unlimited login route is a
  // trivial denial-of-service vector.
  const loginLimiter = new RateLimiter(5, 15 * 60 * 1000);

  const authRoutes = new Hono<AppEnv>();

  authRoutes.post(
    '/login',
    handle(contracts.auth.login, async (c, { body: { email, password } }) => {
      const { db, env, logger } = c.var;

      const ip = resolveClientIp(c);
      const key = `${ip}:${email.toLowerCase()}`;

      if (!loginLimiter.check(key)) {
        const retryAfter = loginLimiter.retryAfterSeconds(key);
        logger.warn('rate_limit_exceeded', { route: 'login', retryAfter });
        return c.json(
          { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${retryAfter}s.` },
          429,
          { 'retry-after': String(retryAfter) },
        );
      }

      const admin = await verifyCredentials(db, email, password);
      if (!admin) {
        logger.warn('auth_login_failed', { email });
        // Deliberately identical for unknown email and wrong password.
        return c.json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }, 401);
      }

      const { token, expiresAt } = await createSession(db, admin.id, env.SESSION_TTL_HOURS, {
        // Hashed, never raw: the column exists to correlate sessions without
        // the table itself becoming a list of admin IP addresses.
        ipHash: hashClientIp(ip),
        userAgent: c.req.header('user-agent'),
      });

      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: env.isProduction,
        path: '/',
        expires: expiresAt,
      });

      loginLimiter.reset(key);
      logger.info('auth_login_succeeded', { adminId: admin.id });
      return c.json({ admin });
    }),
  );

  authRoutes.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await destroySession(c.var.db, token);

    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.var.logger.info('auth_logged_out', {});
    return c.json({ ok: true as const });
  });

  authRoutes.get('/session', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ admin: null });

    // 200 with a null admin rather than 401: the dashboard asks this on boot to
    // decide whether to show the login screen, and a 401 would trip the global
    // "session expired" handling on a perfectly normal first visit.
    const admin = await resolveSession(c.var.db, token);
    return c.json({ admin });
  });

  return authRoutes;
}
