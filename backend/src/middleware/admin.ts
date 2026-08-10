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
export interface OriginCheckOptions {
  /** Exact origins that are always allowed. */
  allowed: string[];
  /**
   * Development only: also accept any port on the same hosts, and loopback.
   *
   * The Vite dev server runs on a different port from the API, and when it is
   * bound to a LAN address so another machine can reach it — an emulator host,
   * for instance — its origin is `http://<lan-ip>:5173`, which no fixed list
   * would contain. Production stays strict: exact match only.
   */
  devLoose?: boolean;
}

export function isOriginAllowed(origin: string, options: OriginCheckOptions): boolean {
  if (options.allowed.includes(origin)) return true;
  if (!options.devLoose) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;

  // Same host as something already allowed, different port.
  return options.allowed.some((candidate) => {
    try {
      return new URL(candidate).hostname === parsed.hostname;
    } catch {
      return false;
    }
  });
}

export function originCheck(options: OriginCheckOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();

    const origin = c.req.header('origin');
    // Non-browser clients (curl, the SDK) send no Origin; the session cookie is
    // the credential there and CSRF does not apply.
    if (origin && !isOriginAllowed(origin, options)) {
      c.var.logger.warn('request_failed', { reason: 'origin_rejected', origin });
      return c.json({ code: 'FORBIDDEN', message: 'Origin not allowed' }, 403);
    }

    await next();
  };
}
