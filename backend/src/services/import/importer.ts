import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import {
  assetStorageKey,
  buildManifest,
  checkApplicationIdentity,
  contentTypeForExtension,
  digestAsset,
  parseExpoClientConfig,
  parseExportMetadata,
  platformsInExport,
  referencedPaths,
  resolveRuntimeVersion,
  serializeManifest,
} from '@oat/protocol';
import {
  type AssetStorage,
  EXPO_CONFIG_FILENAME,
  EXPORT_METADATA_FILENAME,
  type ExpoClientConfig,
} from '@oat/types';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from '../../lib/logger.ts';
import type { SigningService } from '../signing.ts';
import { ArchiveError, openZip, type ZipLimits } from './zip.ts';

/**
 * Release importer.
 *
 * Turns an uploaded `expo export` archive into a draft release: validate,
 * verify the application identity, hash every file, deduplicate against
 * existing assets, upload only what is new, then build and sign one manifest
 * per platform.
 *
 * Ordering is the crash-safety contract: **storage writes happen before
 * database rows**. An orphaned object is harmless (garbage collection reference
 * -counts against `release_assets`), whereas an orphaned row would serve a
 * manifest pointing at bytes that do not exist.
 */

export class ImportError extends Error {
  override readonly name = 'ImportError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ImportDependencies {
  db: OatDatabase;
  storage: AssetStorage;
  signing: SigningService;
  logger: Logger;
  limits: ZipLimits;
}

export interface ImportInput {
  applicationId: string;
  archive: Uint8Array;
  sourceFilename?: string | undefined;
  message?: string | undefined;
  idempotencyKey?: string | undefined;
  createdBy?: string | undefined;
}

export interface ImportOutcome {
  releaseId: string;
  releaseNumber: number;
  importStatus: 'ready' | 'failed';
  error?: string;
}

/**
 * Allocate the next application-local release number atomically.
 *
 * A single INSERT … SELECT avoids the read-modify-write race that two
 * concurrent uploads would otherwise hit, and `UNIQUE(application_id,
 * release_number)` backs it up.
 */
async function allocateRelease(
  db: OatDatabase,
  input: ImportInput,
): Promise<{ releaseId: string; releaseNumber: number }> {
  const releaseId = crypto.randomUUID();
  const now = Date.now();

  await db.run(sql`
    INSERT INTO releases
      (id, application_id, release_number, message, status, import_status,
       source_filename, idempotency_key, created_by, created_at, updated_at)
    SELECT
      ${releaseId},
      ${input.applicationId},
      COALESCE(MAX(release_number), 0) + 1,
      ${input.message ?? null},
      'draft',
      'processing',
      ${input.sourceFilename ?? null},
      ${input.idempotencyKey ?? null},
      ${input.createdBy ?? null},
      ${now},
      ${now}
    FROM releases WHERE application_id = ${input.applicationId}
  `);

  const rows = await db
    .select({ releaseNumber: schema.releases.releaseNumber })
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId))
    .limit(1);

  const releaseNumber = rows[0]?.releaseNumber;
  if (releaseNumber === undefined) {
    throw new ImportError('ALLOCATION_FAILED', 'Could not allocate a release number.');
  }
  return { releaseId, releaseNumber };
}

export async function importRelease(
  deps: ImportDependencies,
  input: ImportInput,
): Promise<ImportOutcome> {
  const { db, storage, signing, logger, limits } = deps;

  const applicationRows = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.id, input.applicationId))
    .limit(1);
  const application = applicationRows[0];
  if (!application) throw new ImportError('APPLICATION_NOT_FOUND', 'Unknown application.');

  // A retried upload must resolve to the same release, not a duplicate.
  if (input.idempotencyKey) {
    const existing = await db
      .select({
        id: schema.releases.id,
        number: schema.releases.releaseNumber,
        status: schema.releases.importStatus,
      })
      .from(schema.releases)
      .where(eq(schema.releases.idempotencyKey, input.idempotencyKey))
      .limit(1);
    const previous = existing[0];
    if (previous) {
      return {
        releaseId: previous.id,
        releaseNumber: previous.number,
        importStatus: previous.status === 'ready' ? 'ready' : 'failed',
      };
    }
  }

  const { releaseId, releaseNumber } = await allocateRelease(db, input);
  logger.info('release_import_started', {
    applicationId: application.id,
    releaseId,
    releaseNumber,
    archiveBytes: input.archive.byteLength,
  });

  const fail = async (code: string, message: string): Promise<never> => {
    await db
      .update(schema.releases)
      .set({ importStatus: 'failed', importError: message })
      .where(eq(schema.releases.id, releaseId));
    logger.warn('release_import_failed', { releaseId, code, message });
    throw new ImportError(code, message);
  };

  try {
    const archive = openZip(input.archive, limits);

    if (!archive.has(EXPORT_METADATA_FILENAME)) {
      await fail(
        'MISSING_METADATA',
        `Archive has no ${EXPORT_METADATA_FILENAME} at its root. Zip the contents of your ` +
          '`dist/` directory, not the directory itself.',
      );
    }
    if (!archive.has(EXPO_CONFIG_FILENAME)) {
      await fail(
        'MISSING_EXPO_CONFIG',
        `Archive has no ${EXPO_CONFIG_FILENAME}. \`expo export\` does not produce it — use ` +
          '`bun run scripts/pack-update.ts` to build the archive, or generate it with ' +
          "@expo/config's getConfig(dir, { isPublicConfig: true }). Without it, " +
          'Constants.expoConfig is empty on device.',
      );
    }

    const metadata = parseExportMetadata(
      new TextDecoder().decode(archive.read(EXPORT_METADATA_FILENAME)),
    );
    const expoConfig: ExpoClientConfig = parseExpoClientConfig(
      new TextDecoder().decode(archive.read(EXPO_CONFIG_FILENAME)),
    );

    const platforms = platformsInExport(metadata);
    if (platforms.length === 0) {
      await fail('NO_PLATFORMS', 'Export contains no android or ios bundle.');
    }

    // The check that stops one application's update being published into
    // another — the reason this matters most on a multi-app platform.
    const identityProblem = checkApplicationIdentity(
      expoConfig,
      {
        androidPackage: application.androidPackage,
        iosBundleIdentifier: application.iosBundleIdentifier,
      },
      platforms,
    );
    if (identityProblem) await fail('IDENTITY_MISMATCH', identityProblem);

    // Every path we will read, derived from metadata.json. Nothing outside this
    // allowlist is ever touched.
    const needed = referencedPaths(metadata, platforms);
    for (const path of needed) {
      if (!archive.has(path)) {
        await fail(
          'MISSING_FILE',
          `metadata.json references "${path}" but the archive does not contain it.`,
        );
      }
    }

    // --- Hash everything once -------------------------------------------
    const digests = new Map<string, ReturnType<typeof digestAsset>>();
    const contents = new Map<string, Uint8Array>();
    for (const path of needed) {
      const bytes = archive.read(path);
      contents.set(path, bytes);
      digests.set(path, digestAsset(bytes));
    }

    // --- Deduplicate against existing assets -----------------------------
    const allHashes = [...digests.values()].map((d) => d.sha256Hex);
    const existingAssets =
      allHashes.length > 0
        ? await db
            .select({ id: schema.assets.id, sha256: schema.assets.sha256 })
            .from(schema.assets)
            .where(inArray(schema.assets.sha256, allHashes))
        : [];
    const assetIdBySha = new Map(existingAssets.map((a) => [a.sha256, a.id]));

    const extByPath = new Map<string, string | null>();
    for (const platform of platforms) {
      const meta = metadata.fileMetadata[platform];
      if (!meta) continue;
      extByPath.set(meta.bundle, null);
      for (const asset of meta.assets) extByPath.set(asset.path, asset.ext);
    }

    // Storage first, database second.
    for (const [path, digest] of digests) {
      const key = assetStorageKey(digest.sha256Hex);
      const ext = extByPath.get(path) ?? null;
      const contentType = ext ? contentTypeForExtension(ext) : 'application/javascript';

      if (!(await storage.exists(key))) {
        await storage.put(key, contents.get(path)!, {
          contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        });
      }

      if (!assetIdBySha.has(digest.sha256Hex)) {
        const assetId = crypto.randomUUID();
        await db
          .insert(schema.assets)
          .values({
            id: assetId,
            sha256: digest.sha256Hex,
            storageKey: key,
            contentType,
            fileExtension: ext,
            sizeBytes: digest.size,
          })
          .onConflictDoNothing();

        // Re-read rather than trusting the insert: a concurrent import may have
        // won the race, in which case we must reuse its row.
        const found = await db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.sha256, digest.sha256Hex))
          .limit(1);
        assetIdBySha.set(digest.sha256Hex, found[0]?.id ?? assetId);
      }
    }

    await db
      .update(schema.releases)
      .set({ importStatus: 'assets_uploaded' })
      .where(eq(schema.releases.id, releaseId));

    // --- Build and sign one manifest per platform ------------------------
    const signer = await signing.getSigner(application.id);
    const createdAt = new Date();

    for (const platform of platforms) {
      const meta = metadata.fileMetadata[platform]!;

      let runtimeVersion: string;
      try {
        runtimeVersion = resolveRuntimeVersion(expoConfig, platform);
      } catch (error) {
        return await fail('RUNTIME_VERSION_UNRESOLVED', (error as Error).message);
      }

      const launchDigest = digests.get(meta.bundle)!;
      const launchAssetId = assetIdBySha.get(launchDigest.sha256Hex)!;

      const manifestAssets = meta.assets.map((asset) => {
        const digest = digests.get(asset.path)!;
        return {
          hash: digest.sha256Base64Url,
          key: digest.md5Hex,
          ext: asset.ext,
          url: storage.getPublicUrl(assetStorageKey(digest.sha256Hex)),
        };
      });

      const updateId = crypto.randomUUID();
      const manifestJson = serializeManifest(
        buildManifest({
          updateId,
          createdAt,
          // The stored value — never the client's request header.
          runtimeVersion,
          launchAsset: {
            hash: launchDigest.sha256Base64Url,
            key: launchDigest.md5Hex,
            url: storage.getPublicUrl(assetStorageKey(launchDigest.sha256Hex)),
          },
          assets: manifestAssets,
          expoClientConfig: expoConfig,
        }),
      );

      const variantId = crypto.randomUUID();
      await db.insert(schema.releaseVariants).values({
        id: variantId,
        releaseId,
        platform,
        runtimeVersion,
        updateId,
        manifest: manifestJson,
        // Signed once, over exactly the bytes stored above.
        manifestSignature: signer ? await signer.sign(manifestJson) : null,
        signingKeyId: signer ? signer.keyId : null,
        launchAssetId,
        expoConfig,
      });

      await db.insert(schema.releaseAssets).values({
        id: crypto.randomUUID(),
        releaseVariantId: variantId,
        assetId: launchAssetId,
        assetKey: launchDigest.md5Hex,
        type: 'launch',
      });

      for (const [index, asset] of meta.assets.entries()) {
        const digest = digests.get(asset.path)!;
        await db
          .insert(schema.releaseAssets)
          .values({
            id: crypto.randomUUID(),
            releaseVariantId: variantId,
            assetId: assetIdBySha.get(digest.sha256Hex)!,
            assetKey: digest.md5Hex,
            type: 'asset',
            fileExtension: asset.ext,
            sortOrder: index,
          })
          // The same asset can legitimately appear twice in one export (e.g.
          // @2x and @3x resolving to identical bytes).
          .onConflictDoNothing();
      }
    }

    const sourceDigest = digestAsset(input.archive);
    await db
      .update(schema.releases)
      .set({
        importStatus: 'ready',
        sourceHash: sourceDigest.sha256Hex,
        sourceSizeBytes: input.archive.byteLength,
      })
      .where(eq(schema.releases.id, releaseId));

    logger.info('release_ready', {
      applicationId: application.id,
      releaseId,
      releaseNumber,
      platforms,
      assetCount: digests.size,
    });

    return { releaseId, releaseNumber, importStatus: 'ready' };
  } catch (error) {
    if (error instanceof ImportError) throw error;

    const message =
      error instanceof ArchiveError ? error.message : `Import failed: ${(error as Error).message}`;
    const code = error instanceof ArchiveError ? error.code : 'IMPORT_FAILED';

    await db
      .update(schema.releases)
      .set({ importStatus: 'failed', importError: message })
      .where(eq(schema.releases.id, releaseId));
    logger.warn('release_import_failed', { releaseId, code, message });

    throw new ImportError(code, message);
  }
}
