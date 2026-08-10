import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import { eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { createLogger } from '../src/lib/logger.ts';
import { ImportError, importRelease } from '../src/services/import/importer.ts';
import { DEFAULT_ZIP_LIMITS, openZip } from '../src/services/import/zip.ts';
import { SigningService } from '../src/services/signing.ts';
import { createMigratedDb, createTestApp, MemoryStorage, SIGNING_FIXTURES } from './helpers.ts';

const EXPORT_DIR = join(
  import.meta.dir,
  '..',
  '..',
  'packages/protocol/tests/fixtures/expo-export-sdk57',
);

/** Build an archive from the real checked-in export. */
function realArchive(overrides: Record<string, Uint8Array | null> = {}): Uint8Array {
  const metadata = JSON.parse(readFileSync(join(EXPORT_DIR, 'metadata.json'), 'utf8'));
  const files: Record<string, Uint8Array> = {};

  for (const platform of ['ios', 'android'] as const) {
    const meta = metadata.fileMetadata[platform];
    if (!meta) continue;
    const bundlePath = meta.bundle.replace(/\\/g, '/');
    files[bundlePath] = new Uint8Array(readFileSync(join(EXPORT_DIR, bundlePath)));
    for (const asset of meta.assets) {
      const path = asset.path.replace(/\\/g, '/');
      files[path] = new Uint8Array(readFileSync(join(EXPORT_DIR, path)));
    }
  }

  files['metadata.json'] = new Uint8Array(readFileSync(join(EXPORT_DIR, 'metadata.json')));
  files['expoConfig.json'] = new Uint8Array(readFileSync(join(EXPORT_DIR, 'expoConfig.json')));

  for (const [name, content] of Object.entries(overrides)) {
    if (content === null) delete files[name];
    else files[name] = content;
  }

  return zipSync(files);
}

let db: OatDatabase;
let storage: MemoryStorage;
let applicationId: string;

let seedCounter = 0;

async function seedApp(identity: { android?: string; ios?: string } = {}) {
  const id = crypto.randomUUID();
  seedCounter += 1;
  await db.insert(schema.applications).values({
    id,
    name: `Fixture ${seedCounter}`,
    slug: `fixture-${seedCounter}`,
    updateKey: `ota_${id.slice(0, 8)}`,
    defaultChannel: 'production',
    androidPackage: identity.android ?? 'xyz.oat.fixture',
    iosBundleIdentifier: identity.ios ?? 'xyz.oat.fixture',
  });
  await db.insert(schema.channels).values({
    id: crypto.randomUUID(),
    applicationId: id,
    name: 'production',
  });
  await db.insert(schema.applicationSigningKeys).values({
    id: crypto.randomUUID(),
    applicationId: id,
    keyId: 'main',
    certificatePem: readFileSync(join(SIGNING_FIXTURES, 'test-cert.pem'), 'utf8'),
    certificateFingerprint: 'test',
    certificateNotAfter: new Date(Date.now() + 86_400_000),
    privateKeyRef: 'test-key.pem',
    status: 'active',
  });
  return id;
}

function deps() {
  const { env } = createTestApp(db, storage);
  return {
    db,
    storage,
    signing: new SigningService(db, env.signingKeysDirAbsolute),
    logger: createLogger('error'),
    limits: DEFAULT_ZIP_LIMITS,
  };
}

beforeEach(async () => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  applicationId = await seedApp();
});

describe('importRelease — happy path', () => {
  test('imports the real SDK 57 export', async () => {
    const result = await importRelease(deps(), {
      applicationId,
      archive: realArchive(),
      sourceFilename: 'update.zip',
    });

    expect(result.importStatus).toBe('ready');
    expect(result.releaseNumber).toBe(1);

    const variants = await db
      .select()
      .from(schema.releaseVariants)
      .where(eq(schema.releaseVariants.releaseId, result.releaseId));

    expect(variants.map((v) => v.platform).sort()).toEqual(['android', 'ios']);

    for (const variant of variants) {
      // The runtime version comes from the uploaded config, not a request header.
      expect(variant.runtimeVersion).toBe('1.0.0');
      expect(variant.manifestSignature).not.toBe(null);
      expect(variant.signingKeyId).toBe('main');

      const manifest = JSON.parse(variant.manifest);
      expect(manifest.runtimeVersion).toBe('1.0.0');
      expect(manifest.assets).toHaveLength(2);
      expect(manifest.extra).toHaveProperty('expoClient');
    }
  });

  test('release numbers are application-local', async () => {
    const second = await seedApp();
    const a = await importRelease(deps(), { applicationId, archive: realArchive() });
    const b = await importRelease(deps(), { applicationId: second, archive: realArchive() });

    expect(a.releaseNumber).toBe(1);
    expect(b.releaseNumber).toBe(1);
  });

  test('deduplicates assets shared between platforms and releases', async () => {
    await importRelease(deps(), { applicationId, archive: realArchive() });
    const objectsAfterFirst = storage.objects.size;

    // Same content again: no new physical objects, no new asset rows.
    await importRelease(deps(), { applicationId, archive: realArchive() });
    expect(storage.objects.size).toBe(objectsAfterFirst);

    const assets = await db.select().from(schema.assets);
    // 2 bundles + 2 images, shared across both platforms and both releases.
    expect(assets).toHaveLength(4);
  });

  test('is idempotent for a repeated Idempotency-Key', async () => {
    const first = await importRelease(deps(), {
      applicationId,
      archive: realArchive(),
      idempotencyKey: 'retry-1',
    });
    const second = await importRelease(deps(), {
      applicationId,
      archive: realArchive(),
      idempotencyKey: 'retry-1',
    });

    expect(second.releaseId).toBe(first.releaseId);
    const releases = await db.select().from(schema.releases);
    expect(releases).toHaveLength(1);
  });
});

describe('importRelease — validation', () => {
  async function expectFailure(archive: Uint8Array, code: string) {
    const promise = importRelease(deps(), { applicationId, archive });
    await expect(promise).rejects.toThrow(ImportError);
    try {
      await promise;
    } catch (error) {
      expect((error as ImportError).code).toBe(code);
    }
  }

  test('rejects an archive with no metadata.json', async () => {
    await expectFailure(realArchive({ 'metadata.json': null }), 'MISSING_METADATA');
  });

  test('rejects an archive with no expoConfig.json', async () => {
    // `expo export` does not produce it, so the error must say how to get one.
    const promise = importRelease(deps(), {
      applicationId,
      archive: realArchive({ 'expoConfig.json': null }),
    });
    await expect(promise).rejects.toThrow(/pack-update|isPublicConfig/);
  });

  test('rejects a bundle referenced but absent', async () => {
    const metadata = JSON.parse(readFileSync(join(EXPORT_DIR, 'metadata.json'), 'utf8'));
    const bundlePath = metadata.fileMetadata.android.bundle.replace(/\\/g, '/');
    await expectFailure(realArchive({ [bundlePath]: null }), 'MISSING_FILE');
  });

  test('rejects an asset referenced but absent', async () => {
    const metadata = JSON.parse(readFileSync(join(EXPORT_DIR, 'metadata.json'), 'utf8'));
    const assetPath = metadata.fileMetadata.android.assets[0].path.replace(/\\/g, '/');
    await expectFailure(realArchive({ [assetPath]: null }), 'MISSING_FILE');
  });

  test('rejects something that is not a zip', async () => {
    await expectFailure(new TextEncoder().encode('not a zip at all'), 'NOT_A_ZIP');
  });

  test('rejects an export whose identity belongs to another application', async () => {
    const other = await seedApp({ android: 'com.example.lekho', ios: 'com.example.lekho' });
    const promise = importRelease(deps(), { applicationId: other, archive: realArchive() });

    await expect(promise).rejects.toThrow(/another application/);
    // The message must name both values so the mistake is obvious.
    await expect(promise).rejects.toThrow(/com\.example\.lekho/);
    await expect(promise).rejects.toThrow(/xyz\.oat\.fixture/);
  });

  test('a failed import leaves the release unpublishable', async () => {
    await expectFailure(realArchive({ 'metadata.json': null }), 'MISSING_METADATA');

    const releases = await db.select().from(schema.releases);
    expect(releases[0]?.importStatus).toBe('failed');
    expect(releases[0]?.importError).toBeTruthy();
  });
});

describe('archive security', () => {
  test('rejects a path traversal entry', () => {
    const archive = zipSync({
      'metadata.json': strToU8('{}'),
      '../../../etc/passwd': strToU8('pwned'),
    });
    expect(() => openZip(archive)).toThrow(/unsafe entry name/i);
  });

  test('rejects an absolute path entry', () => {
    const archive = zipSync({ '/etc/passwd': strToU8('pwned') });
    expect(() => openZip(archive)).toThrow(/unsafe entry name/i);
  });

  test('rejects a Windows drive-letter entry', () => {
    const archive = zipSync({ 'C:/Windows/System32/evil': strToU8('pwned') });
    expect(() => openZip(archive)).toThrow(/unsafe entry name/i);
  });

  test('rejects a decompression bomb before inflating it', () => {
    // 5 MB of zeros compresses to a few KB — a ~1000:1 ratio.
    const bomb = zipSync({ 'metadata.json': new Uint8Array(5 * 1024 * 1024) });
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(() => openZip(bomb)).toThrow(/decompression bomb/i);
  });

  test('rejects too many entries', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 60; i++) files[`f${i}.txt`] = strToU8(`x${i}`);
    expect(() => openZip(zipSync(files), { ...DEFAULT_ZIP_LIMITS, maxEntries: 50 })).toThrow(
      /more than 50 entries/,
    );
  });

  test('rejects an archive that expands beyond the total limit', () => {
    const archive = zipSync({ 'a.bin': crypto.getRandomValues(new Uint8Array(200_000)) });
    expect(() =>
      openZip(archive, { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 100_000 }),
    ).toThrow(/expands to more than/);
  });

  test('rejects an entry over the per-entry limit', () => {
    const archive = zipSync({ 'a.bin': crypto.getRandomValues(new Uint8Array(200_000)) });
    expect(() => openZip(archive, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 100_000 })).toThrow(
      /over the 100000 byte limit/,
    );
  });

  test('tolerates small files that compress larger than themselves', () => {
    // A naive ratio check would reject these; the guard skips entries under 4 KB.
    const archive = zipSync({ 'metadata.json': strToU8('{"a":1}') });
    expect(() => openZip(archive)).not.toThrow();
  });
});
