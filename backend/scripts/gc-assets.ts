import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { and, eq, lt, notExists, sql } from 'drizzle-orm';
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
const graceArg = process.argv.indexOf('--grace-days');
const graceDays = graceArg === -1 ? 7 : Number(process.argv[graceArg + 1]);

if (!Number.isFinite(graceDays) || graceDays < 0) {
  console.error(`Invalid grace period: ${process.argv[graceArg + 1]}. Pass --grace-days <n>.`);
  process.exit(1);
}

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL });
const storage = createStorage(env);

const cutoff = new Date(Date.now() - graceDays * 86_400_000);

// Correlated rather than `NOT IN (<every referenced id>)`, which would bind one
// parameter per reference and eventually exceed SQLite's variable limit.
const unreferenced = notExists(
  db
    .select({ one: sql`1` })
    .from(schema.releaseAssets)
    .where(eq(schema.releaseAssets.assetId, schema.assets.id)),
);

const orphans = await db
  .select({
    id: schema.assets.id,
    storageKey: schema.assets.storageKey,
    sizeBytes: schema.assets.sizeBytes,
  })
  .from(schema.assets)
  .where(and(lt(schema.assets.createdAt, cutoff), unreferenced));

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

let removed = 0;
let removedBytes = 0;
for (const orphan of orphans) {
  // An import may have deduplicated against this asset since the scan above.
  // Re-check right before deleting so a newly referenced object survives.
  const stillOrphaned = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, orphan.id), unreferenced))
    .limit(1);
  if (stillOrphaned.length === 0) {
    console.log(`kept ${orphan.storageKey} (referenced again)`);
    continue;
  }

  // Object first, row second: an orphaned object is harmless and will be caught
  // by the next run, whereas a row without an object serves broken manifests.
  await storage.delete(orphan.storageKey);
  await db.delete(schema.assets).where(sql`id = ${orphan.id}`);
  removed += 1;
  removedBytes += orphan.sizeBytes;
  console.log(`deleted ${orphan.storageKey}`);
}

console.log(`\nRemoved ${removed} asset(s), ${(removedBytes / 1024 / 1024).toFixed(1)} MB.`);
