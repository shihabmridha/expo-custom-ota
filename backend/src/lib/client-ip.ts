import type { Context } from 'hono';
import type { AppEnv } from '../app-env.ts';

/**
 * Client IP resolution, for login rate limiting and session metadata.
 *
 * `x-forwarded-for` is written by the caller, so it is read only when
 * TRUST_PROXY says a proxy we control actually sits in front of us — otherwise
 * an attacker spoofs a fresh header per login attempt and gets a fresh
 * rate-limit bucket every time.
 *
 * When it is read, the RIGHTMOST entry is the one to use: nginx's
 * `$proxy_add_x_forwarded_for` *appends* `$remote_addr`, so the last entry is
 * what our own proxy observed and everything to its left came from the caller.
 * The deployed topology is exactly one hop — see `dashboard/nginx.conf` and the
 * `TRUST_PROXY` note in `docker-compose.yml`.
 */

/** Used when no socket address is available, e.g. `app.fetch` called directly. */
export const UNKNOWN_CLIENT_IP = 'local';

interface SocketAddressSource {
  requestIP(request: Request): { address: string } | null;
}

/**
 * Bun passes its server as `fetch`'s second argument, which Hono surfaces as
 * `c.env`. It is absent whenever the app is driven through `app.fetch(request)`
 * without one, which is how the tests call it.
 */
function socketAddress(c: Context<AppEnv>): string | null {
  const bindings = c.env as Record<string, unknown> | undefined;
  const server = (
    bindings && 'server' in bindings ? bindings.server : bindings
  ) as SocketAddressSource | null;

  if (!server || typeof server.requestIP !== 'function') return null;
  return server.requestIP(c.req.raw)?.address ?? null;
}

export function resolveClientIp(c: Context<AppEnv>): string {
  if (c.var.env.TRUST_PROXY) {
    const entries = c.req.header('x-forwarded-for')?.split(',');
    const nearest = entries?.[entries.length - 1]?.trim();
    if (nearest) return nearest;
  }

  return socketAddress(c) ?? UNKNOWN_CLIENT_IP;
}

/** Sessions store only this, so a leaked session table exposes no client IPs. */
export function hashClientIp(ip: string): string {
  return new Bun.CryptoHasher('sha256').update(ip).digest('hex');
}
