import { assets } from '@oat/db';
import { ASSET_CACHE_CONTROL } from '@oat/protocol';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.ts';

/**
 * Asset delivery.
 *
 * Only used when assets are proxied through the backend (the local driver, or
 * R2 without a public bucket URL). When `R2_PUBLIC_URL` is set, manifests point
 * straight at the bucket and this route is never hit.
 */
export const assetRoutes = new Hono<AppEnv>();

assetRoutes.get('/sha256/:shard/:hash', async (c) => {
  const { db, storage, logger } = c.var;

  const shard = c.req.param('shard');
  const hash = c.req.param('hash');

  // Reject anything that isn't a well-formed content address before touching
  // the database or the filesystem.
  if (!/^[0-9a-f]{2}$/.test(shard) || !/^[0-9a-f]{64}$/.test(hash) || !hash.startsWith(shard)) {
    return c.text('Not found', 404);
  }

  const rows = await db
    .select({
      storageKey: assets.storageKey,
      contentType: assets.contentType,
      sizeBytes: assets.sizeBytes,
    })
    .from(assets)
    .where(eq(assets.sha256, hash))
    .limit(1);

  const asset = rows[0];
  if (!asset) return c.text('Not found', 404);

  // The content address IS the ETag — the bytes can never change.
  const etag = `"${hash}"`;
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': ASSET_CACHE_CONTROL },
    });
  }

  const body = await storage.get(asset.storageKey);
  if (!body) {
    logger.error('storage_failure', {
      reason: 'asset row exists but the object is missing from storage',
      storageKey: asset.storageKey,
    });
    return c.text('Not found', 404);
  }

  return new Response(body, {
    headers: {
      'content-type': asset.contentType,
      'content-length': String(asset.sizeBytes),
      'cache-control': ASSET_CACHE_CONTROL,
      etag,
      // A client may send `A-IM: bsdiff`. We do not implement RFC 3229 delta
      // encoding, so we ignore it and return the full body with a plain 200 —
      // never 226 IM Used, which would make the client expect a patch.
    },
  });
});
