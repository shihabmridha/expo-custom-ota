#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.ts';
import { createLogger } from '../src/lib/logger.ts';
import { importRelease } from '../src/services/import/importer.ts';
import {
  createRollbackRelease,
  publishRelease,
  setRollBackToEmbedded,
} from '../src/services/publishing.ts';
import { SigningService } from '../src/services/signing.ts';
import { createStorage } from '../src/storage/index.ts';

/**
 * Import an archive and publish it, in one step.
 *
 * Uses the service layer directly rather than the HTTP API, so device
 * verification does not need an interactive login for every iteration. The
 * services are the same ones the API routes call, and the HTTP path is covered
 * by the integration tests.
 *
 *   bun run e2e:publish -- --zip e2e/expo-test-app/update.zip --message "VERSION B"
 *   bun run e2e:publish -- --zip … --channel staging --slug oat-e2e
 *   bun run e2e:publish -- --rollback-to 1 --message "Rollback to B"
 *   bun run e2e:publish -- --roll-back-to-embedded --runtime 1.0.0
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const zipPath = resolve(arg('zip') ?? 'e2e/expo-test-app/update.zip');
const slug = arg('slug', 'oat-e2e')!;
const channel = arg('channel', 'production')!;
const message = arg('message');

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL });
const storage = createStorage(env);
const logger = createLogger('warn');

const found = await db
  .select()
  .from(schema.applications)
  .where(eq(schema.applications.slug, slug))
  .limit(1);

const application = found[0];
if (!application) {
  console.error(`No application with slug "${slug}". Run \`bun run e2e:setup\` first.`);
  process.exit(1);
}

/**
 * `--roll-back-to-embedded` deploys the kill-switch: devices discard downloaded
 * updates and run the bundle inside their binary. The only way to un-ship an
 * update to devices that already took it, without publishing new JavaScript.
 */
if (process.argv.includes('--roll-back-to-embedded')) {
  const runtimeVersion = arg('runtime', '1.0.0')!;

  for (const platform of ['android', 'ios'] as const) {
    await setRollBackToEmbedded(
      { db, logger },
      { applicationId: application.id, channel, platform, runtimeVersion },
    );
    console.log(
      `  ${platform.padEnd(8)} ${channel} runtime ${runtimeVersion} → rollBackToEmbedded`,
    );
  }

  console.log(
    '\nDevices report their embedded update id; those that do not send one get ' +
      'noUpdateAvailable rather than a directive they cannot act on.',
  );
  process.exit(0);
}

/**
 * `--rollback-to <releaseNumber>` republishes an earlier release's contents as
 * a **new** release, rather than importing an archive.
 */
const rollbackTo = arg('rollback-to');
if (rollbackTo) {
  const source = await db
    .select()
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, application.id),
        eq(schema.releases.releaseNumber, Number(rollbackTo)),
      ),
    )
    .limit(1);

  if (!source[0]) {
    console.error(`No release #${rollbackTo} in "${slug}".`);
    process.exit(1);
  }

  const result = await createRollbackRelease(
    { db, logger, signing: new SigningService(db, env.signingKeysDirAbsolute) },
    {
      sourceReleaseId: source[0].id,
      channel,
      ...(message ? { message } : {}),
    },
  );

  console.log(
    `Rolled back to release #${rollbackTo} as NEW release #${result.releaseNumber}, ` +
      `published to "${channel}":`,
  );
  for (const deployment of result.deployments) {
    console.log(
      `  ${deployment.platform.padEnd(8)} runtime ${deployment.runtimeVersion}  →  ${deployment.updateId}`,
    );
  }
  console.log('\nThe update ids are new — clients are never pointed backwards at an old one.');
  process.exit(0);
}

const archive = new Uint8Array(readFileSync(zipPath));
console.log(`Importing ${zipPath} (${(archive.byteLength / 1024 / 1024).toFixed(2)} MB)…`);

const imported = await importRelease(
  {
    db,
    storage,
    signing: new SigningService(db, env.signingKeysDirAbsolute),
    logger,
    limits: {
      maxEntries: env.MAX_ARCHIVE_ENTRIES,
      maxTotalUncompressedBytes: env.MAX_EXTRACTED_BYTES,
      maxEntryBytes: env.MAX_UPLOAD_BYTES,
      maxCompressionRatio: env.MAX_COMPRESSION_RATIO,
    },
  },
  {
    applicationId: application.id,
    archive,
    sourceFilename: zipPath.split(/[\\/]/).pop() ?? 'update.zip',
    ...(message ? { message } : {}),
  },
);

console.log(`  release #${imported.releaseNumber} — ${imported.importStatus}`);

const published = await publishRelease({ db, logger }, { releaseId: imported.releaseId, channel });

console.log(`\nPublished to "${channel}":`);
for (const deployment of published.deployments) {
  console.log(
    `  ${deployment.platform.padEnd(8)} runtime ${deployment.runtimeVersion}  →  ${deployment.updateId}`,
  );
}
console.log('\nRelaunch the app twice: the first launch downloads, the second runs it.');
