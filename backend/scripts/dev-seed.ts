import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import {
  assetStorageKey,
  buildManifest,
  contentTypeForExtension,
  createSigner,
  digestAsset,
  parseExpoClientConfig,
  parseExportMetadata,
  platformsInExport,
  resolveRuntimeVersion,
  serializeManifest,
} from '@ota/protocol';
import { loadEnv } from '../src/config/env.ts';
import { createStorage } from '../src/storage/index.ts';

/**
 * Seed a development database from the checked-in Expo export fixture.
 *
 * This does by hand what the release importer will do in Phase 6, so the public
 * update endpoint can be exercised against real bundle bytes before the
 * importer exists.
 *
 *   bun run backend/scripts/dev-seed.ts
 */
const REPO_ROOT = join(import.meta.dir, '..', '..');
const EXPORT_DIR = join(REPO_ROOT, 'packages/protocol/tests/fixtures/expo-export-sdk57');
const SIGNING_DIR = join(REPO_ROOT, 'packages/protocol/tests/fixtures/signing');

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
const storage = createStorage(env);

const metadata = parseExportMetadata(readFileSync(join(EXPORT_DIR, 'metadata.json'), 'utf8'));
const expoConfig = parseExpoClientConfig(readFileSync(join(EXPORT_DIR, 'expoConfig.json'), 'utf8'));
const platforms = platformsInExport(metadata);

const UPDATE_KEY = 'ota_devfixture000000';
const SLUG = 'dev-fixture';

// Start clean so the script is re-runnable.
const existing = await db.select().from(schema.applications);
for (const app of existing.filter((a) => a.slug === SLUG)) {
  await db.delete(schema.applications).where(
    // biome-ignore lint/suspicious/noExplicitAny: local narrow use
    (await import('drizzle-orm')).eq(schema.applications.id, app.id) as any,
  );
}

const applicationId = crypto.randomUUID();
await db.insert(schema.applications).values({
  id: applicationId,
  name: 'Dev Fixture',
  slug: SLUG,
  updateKey: UPDATE_KEY,
  defaultChannel: 'production',
  androidPackage: expoConfig.android?.package ?? null,
  iosBundleIdentifier: expoConfig.ios?.bundleIdentifier ?? null,
});

const channelIds: Record<string, string> = {};
for (const name of ['production', 'staging']) {
  const id = crypto.randomUUID();
  channelIds[name] = id;
  await db.insert(schema.channels).values({ id, applicationId, name });
}

await db.insert(schema.applicationSigningKeys).values({
  id: crypto.randomUUID(),
  applicationId,
  keyId: 'main',
  certificatePem: readFileSync(join(SIGNING_DIR, 'test-cert.pem'), 'utf8'),
  certificateFingerprint: 'dev',
  certificateNotAfter: new Date(Date.now() + 3650 * 86_400_000),
  privateKeyRef: join(SIGNING_DIR, 'test-key.pem'),
  status: 'active',
});

const releaseId = crypto.randomUUID();
await db.insert(schema.releases).values({
  id: releaseId,
  applicationId,
  releaseNumber: 1,
  message: 'Seeded from the SDK 57 export fixture',
  status: 'published',
  importStatus: 'ready',
});

const signer = await createSigner(readFileSync(join(SIGNING_DIR, 'test-key.pem'), 'utf8'), 'main');

/** Store an object and its asset row, deduplicating on sha256. */
async function storeAsset(relativePath: string, ext: string | null) {
  const bytes = new Uint8Array(readFileSync(join(EXPORT_DIR, relativePath)));
  const digest = digestAsset(bytes);
  const storageKey = assetStorageKey(digest.sha256Hex);
  const contentType = ext ? contentTypeForExtension(ext) : 'application/javascript';

  await storage.put(storageKey, bytes, { contentType });

  const found = await db.select().from(schema.assets);
  const existingAsset = found.find((a) => a.sha256 === digest.sha256Hex);
  if (existingAsset) return { assetId: existingAsset.id, digest, storageKey };

  const assetId = crypto.randomUUID();
  await db.insert(schema.assets).values({
    id: assetId,
    sha256: digest.sha256Hex,
    storageKey,
    contentType,
    fileExtension: ext,
    sizeBytes: digest.size,
  });
  return { assetId, digest, storageKey };
}

for (const platform of platforms) {
  const platformMeta = metadata.fileMetadata[platform]!;
  const runtimeVersion = resolveRuntimeVersion(expoConfig, platform);

  const launch = await storeAsset(platformMeta.bundle, null);
  const assets = [];
  for (const asset of platformMeta.assets) {
    const stored = await storeAsset(asset.path, asset.ext);
    assets.push({
      hash: stored.digest.sha256Base64Url,
      key: stored.digest.md5Hex,
      ext: asset.ext,
      url: storage.getPublicUrl(stored.storageKey),
      assetId: stored.assetId,
    });
  }

  const updateId = crypto.randomUUID();
  const manifestJson = serializeManifest(
    buildManifest({
      updateId,
      createdAt: new Date(),
      runtimeVersion,
      launchAsset: {
        hash: launch.digest.sha256Base64Url,
        key: launch.digest.md5Hex,
        url: storage.getPublicUrl(launch.storageKey),
      },
      assets,
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
    // Signed once, over exactly these bytes.
    manifestSignature: await signer.sign(manifestJson),
    signingKeyId: 'main',
    launchAssetId: launch.assetId,
    expoConfig,
  });

  await db.insert(schema.releaseAssets).values({
    id: crypto.randomUUID(),
    releaseVariantId: variantId,
    assetId: launch.assetId,
    assetKey: launch.digest.md5Hex,
    type: 'launch',
  });
  for (const [index, asset] of assets.entries()) {
    await db.insert(schema.releaseAssets).values({
      id: crypto.randomUUID(),
      releaseVariantId: variantId,
      assetId: asset.assetId,
      assetKey: asset.key,
      type: 'asset',
      fileExtension: asset.ext,
      sortOrder: index,
    });
  }

  await db.insert(schema.deployments).values({
    id: crypto.randomUUID(),
    applicationId,
    channelId: channelIds.production!,
    platform,
    runtimeVersion,
    releaseVariantId: variantId,
  });

  console.log(
    `  ${platform.padEnd(8)} runtime ${runtimeVersion}  update ${updateId}  ${assets.length} assets`,
  );
}

console.log(`\nSeeded application "${SLUG}"`);
console.log(`  OTA URL: ${env.OTA_PUBLIC_URL}/api/v1/updates/${UPDATE_KEY}`);
