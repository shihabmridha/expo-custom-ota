import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import {
  assetStorageKey,
  buildManifest,
  createSigner,
  digestAsset,
  serializeManifest,
} from '@oat/protocol';
import type { AssetStorage, Platform } from '@oat/types';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/config/env.ts';
import { createLogger } from '../src/lib/logger.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');
export const SIGNING_FIXTURES = join(
  REPO_ROOT,
  'packages',
  'protocol',
  'tests',
  'fixtures',
  'signing',
);

export const TEST_CERT_PEM = readFileSync(join(SIGNING_FIXTURES, 'test-cert.pem'), 'utf8');

export function createMigratedDb(): OatDatabase {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  return drizzle({ client: sqlite, schema }) as unknown as OatDatabase;
}

/** In-memory storage, so tests never touch the filesystem. */
export class MemoryStorage implements AssetStorage {
  readonly objects = new Map<string, Uint8Array>();

  async exists(key: string) {
    return this.objects.has(key);
  }
  async put(key: string, data: Blob | ReadableStream<Uint8Array> | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.objects.set(key, data);
      return;
    }
    const blob = data instanceof Blob ? data : await Bun.readableStreamToBlob(data);
    this.objects.set(key, new Uint8Array(await blob.arrayBuffer()));
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return new Blob([bytes]).stream();
  }
  async stat(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }
  getPublicUrl(key: string) {
    return `http://localhost:3000/api/v1/assets/${key}`;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function createTestApp(db: OatDatabase, storage: AssetStorage = new MemoryStorage()) {
  const env = loadEnv({
    NODE_ENV: 'test',
    OTA_PUBLIC_URL: 'http://localhost:3000',
    SIGNING_KEYS_DIRECTORY: SIGNING_FIXTURES,
    LOG_LEVEL: 'error',
  });
  return { app: createApp({ env, db, storage, logger: createLogger('error') }), env, storage };
}

export interface SeedOptions {
  slug: string;
  updateKey: string;
  channel?: string;
  platform?: Platform;
  runtimeVersion?: string;
  bundleContent?: string;
  signed?: boolean;
}

export interface SeededApplication {
  applicationId: string;
  channelId: string;
  releaseId: string;
  variantId: string;
  updateId: string;
  manifestJson: string;
}

/**
 * Seed one application all the way through to a live deployment, the way the
 * importer will once it exists.
 */
export async function seedApplication(
  db: OatDatabase,
  storage: AssetStorage,
  options: SeedOptions,
): Promise<SeededApplication> {
  const {
    slug,
    updateKey,
    channel = 'production',
    platform = 'android',
    runtimeVersion = '1.0.0',
    bundleContent = `// bundle for ${slug}`,
    signed = true,
  } = options;

  const applicationId = crypto.randomUUID();
  await db.insert(schema.applications).values({
    id: applicationId,
    name: slug,
    slug,
    updateKey,
    defaultChannel: 'production',
    androidPackage: `xyz.${slug}.mobile`,
    iosBundleIdentifier: `xyz.${slug}.mobile`,
  });

  const channelId = crypto.randomUUID();
  await db.insert(schema.channels).values({ id: channelId, applicationId, name: channel });

  if (signed) {
    await db.insert(schema.applicationSigningKeys).values({
      id: crypto.randomUUID(),
      applicationId,
      keyId: 'main',
      certificatePem: TEST_CERT_PEM,
      certificateFingerprint: 'test',
      certificateNotAfter: new Date(Date.now() + 86_400_000),
      privateKeyRef: 'test-key.pem',
      status: 'active',
    });
  }

  const bundleBytes = new TextEncoder().encode(bundleContent);
  const digest = digestAsset(bundleBytes);
  const storageKey = assetStorageKey(digest.sha256Hex);
  await storage.put(storageKey, bundleBytes, { contentType: 'application/javascript' });

  const assetId = crypto.randomUUID();
  await db
    .insert(schema.assets)
    .values({
      id: assetId,
      sha256: digest.sha256Hex,
      storageKey,
      contentType: 'application/javascript',
      sizeBytes: digest.size,
    })
    .onConflictDoNothing();

  const releaseId = crypto.randomUUID();
  await db.insert(schema.releases).values({
    id: releaseId,
    applicationId,
    releaseNumber: 1,
    status: 'published',
    importStatus: 'ready',
  });

  const updateId = crypto.randomUUID();
  const manifest = buildManifest({
    updateId,
    createdAt: new Date('2026-08-10T12:00:00.000Z'),
    runtimeVersion,
    launchAsset: {
      hash: digest.sha256Base64Url,
      key: digest.md5Hex,
      url: storage.getPublicUrl(storageKey),
    },
    assets: [],
    expoClientConfig: { name: slug, slug, runtimeVersion },
  });
  const manifestJson = serializeManifest(manifest);

  let manifestSignature: string | null = null;
  if (signed) {
    const signer = await createSigner(
      readFileSync(join(SIGNING_FIXTURES, 'test-key.pem'), 'utf8'),
      'main',
    );
    manifestSignature = await signer.sign(manifestJson);
  }

  const variantId = crypto.randomUUID();
  await db.insert(schema.releaseVariants).values({
    id: variantId,
    releaseId,
    platform,
    runtimeVersion,
    updateId,
    manifest: manifestJson,
    manifestSignature,
    signingKeyId: signed ? 'main' : null,
    launchAssetId: assetId,
  });

  await db.insert(schema.deployments).values({
    id: crypto.randomUUID(),
    applicationId,
    channelId,
    platform,
    runtimeVersion,
    releaseVariantId: variantId,
  });

  return { applicationId, channelId, releaseId, variantId, updateId, manifestJson };
}

/** Headers a real `expo-updates` client sends. */
export function clientHeaders(overrides: Record<string, string | null> = {}): Headers {
  const headers = new Headers({
    accept: 'multipart/mixed,application/expo+json,application/json',
    'expo-platform': 'android',
    'expo-protocol-version': '1',
    'expo-api-version': '1',
    'expo-updates-environment': 'BARE',
    'expo-json-error': 'true',
    'expo-runtime-version': '1.0.0',
    'expo-channel-name': 'production',
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return headers;
}
