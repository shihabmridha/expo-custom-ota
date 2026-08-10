import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app-env.ts';
import { resolveSession, SESSION_COOKIE } from '../services/auth.ts';

/**
 * Session authentication for `/api/admin/*`.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Not signed in' }, 401);
  }

  const admin = await resolveSession(c.var.db, token);
  if (!admin) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Session expired' }, 401);
  }

  c.set('admin', admin);
  await next();
};

/**
 * CSRF protection by Origin allowlist.
 *
 * This is complete for our threat model without double-submit tokens, because
 * every admin mutation uses `application/json` or `application/zip` — both of
 * which force a CORS preflight a cross-site page cannot satisfy — and the
 * session cookie is `SameSite=Lax`, which already blocks cross-site attachment
 * on non-GET. Recorded in docs/decisions.md (D8) so it is not "fixed" later.
 */
export function originCheck(allowedOrigins: string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedOrigins);

  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();

    const origin = c.req.header('origin');
    // Non-browser clients (curl, the SDK) send no Origin; the session cookie is
    // the credential there and CSRF does not apply.
    if (origin && !allowed.has(origin)) {
      c.var.logger.warn('request_failed', { reason: 'origin_rejected', origin });
      return c.json({ code: 'FORBIDDEN', message: 'Origin not allowed' }, 403);
    }

    await next();
  };
}
