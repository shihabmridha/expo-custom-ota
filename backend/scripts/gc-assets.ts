import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { lt, notInArray, sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.ts';
import { createStorage } from '../src/storage/index.ts';

/**
 * Garbage-collect unreferenced assets.
 *
 * Assets are shared across releases and applications, so removal is
 * reference-counted against `release_assets` rather than cascaded. A grace
 * period protects objects written during an import that has not yet inserted
 * its rows — storage writes deliberately happen first.
 *
 *   bun run gc:assets              # dry run
 *   bun run gc:assets -- --apply
 */
const apply = process.argv.includes('--apply');
const graceDays = Number(process.argv[process.argv.indexOf('--grace-days') + 1] || '7');

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL });
const storage = createStorage(env);

const cutoff = new Date(Date.now() - graceDays * 86_400_000);

const referenced = await db
  .select({ assetId: schema.releaseAssets.assetId })
  .from(schema.releaseAssets);
const referencedIds = referenced.map((r) => r.assetId);

const orphans = await db
  .select({
    id: schema.assets.id,
    storageKey: schema.assets.storageKey,
    sizeBytes: schema.assets.sizeBytes,
  })
  .from(schema.assets)
  .where(
    referencedIds.length > 0
      ? sql`${lt(schema.assets.createdAt, cutoff)} AND ${notInArray(schema.assets.id, referencedIds)}`
      : lt(schema.assets.createdAt, cutoff),
  );

const totalBytes = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);

console.log(
  `${orphans.length} unreferenced asset(s) older than ${graceDays} day(s), ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB.`,
);

if (!apply) {
  for (const orphan of orphans.slice(0, 20)) console.log(`  would delete ${orphan.storageKey}`);
  if (orphans.length > 20) console.log(`  … and ${orphans.length - 20} more`);
  console.log('\nDry run. Re-run with --apply to delete.');
  process.exit(0);
}

for (const orphan of orphans) {
  // Object first, row second: an orphaned object is harmless and will be caught
  // by the next run, whereas a row without an object serves broken manifests.
  await storage.delete(orphan.storageKey);
  await db.delete(schema.assets).where(sql`id = ${orphan.id}`);
  console.log(`deleted ${orphan.storageKey}`);
}

console.log(`\nRemoved ${orphans.length} asset(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);
