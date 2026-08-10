import { existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app-env.ts';

/**
 * Serve the built dashboard.
 *
 * Mounted last, after every `/api` route, so it only ever handles what the API
 * did not. Unknown paths fall back to `index.html` because the SPA owns its own
 * routing — but `/api/*` is excluded from that fallback, or a typo'd API path
 * would return HTML with a 200 instead of a 404.
 */
export function serveSpa(distDir: string): MiddlewareHandler<AppEnv> {
  const indexPath = join(distDir, 'index.html');

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (c.req.path.startsWith('/api/')) return next();

    // Resolve within the dist directory only. Keys come from the URL, so this
    // is the one place a traversal could reach the filesystem.
    const requested = normalize(join(distDir, decodeURIComponent(c.req.path)));
    if (requested !== distDir && !requested.startsWith(distDir + sep)) {
      return c.text('Not found', 404);
    }

    if (c.req.path !== '/' && existsSync(requested)) {
      const file = Bun.file(requested);
      if (await file.exists()) {
        // Vite emits content-hashed asset filenames, so those are immutable;
        // anything else must be revalidated or a deploy would not take effect.
        const immutable = c.req.path.startsWith('/assets/');
        return new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        });
      }
    }

    const index = Bun.file(indexPath);
    if (!(await index.exists())) return next();
    return new Response(index, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  };
}
