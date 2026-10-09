import { expect, test } from 'bun:test';
import type { metricsSchema } from '@ota/contracts';
import * as schema from '@ota/db/schema/index';
import type { z } from 'zod';
import { createAdmin } from '../src/services/auth.ts';
import { createMigratedDb, createTestApp, MemoryStorage, seedApplication } from './helpers.ts';

test('storage totals count distinct assets that share a byte size', async () => {
  const db = createMigratedDb();
  const storage = new MemoryStorage();
  const { app } = createTestApp(db, storage);
  await createAdmin(db, { email: 'admin@example.com', password: 'correct-horse-battery-staple' });
  const seeded = await seedApplication(db, storage, { slug: 'sizes', updateKey: 'ota_sizes' });

  // Two different assets of identical size, each referenced twice (once per
  // key), so both the size collision and the duplicate join rows are exercised.
  for (const sha256 of ['a'.repeat(64), 'b'.repeat(64)]) {
    const assetId = crypto.randomUUID();
    await db.insert(schema.assets).values({
      id: assetId,
      sha256,
      storageKey: `sha256/${sha256.slice(0, 2)}/${sha256}`,
      contentType: 'image/png',
      sizeBytes: 1000,
    });
    for (const assetKey of [`${sha256}-1`, `${sha256}-2`]) {
      await db.insert(schema.releaseAssets).values({
        id: crypto.randomUUID(),
        releaseVariantId: seeded.variantId,
        assetId,
        assetKey,
        type: 'asset',
      });
    }
  }

  const login = await app.fetch(
    new Request('http://localhost/api/admin/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      }),
    }),
  );
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const response = await app.fetch(
    new Request(`http://localhost/api/admin/applications/${seeded.applicationId}/metrics`, {
      headers: { cookie },
    }),
  );
  const metrics = (await response.json()) as z.infer<typeof metricsSchema>;

  expect(metrics.totals.assets).toBe(2);
  expect(metrics.totals.storageBytes).toBe(2000);
});
