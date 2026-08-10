import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  parseExpoClientConfig,
  parseExportMetadata,
  platformsInExport,
} from '../src/export-metadata.ts';
import { assetStorageKey, digestAsset, sha256Base64Url, sha256Hex } from '../src/hash.ts';
import {
  buildManifest,
  contentTypeForExtension,
  isUuidFormatted,
  type ManifestAssetInput,
  serializeManifest,
} from '../src/manifest.ts';
import { FIXTURES_DIR } from './helpers.ts';

const EXPORT_DIR = join(FIXTURES_DIR, 'expo-export-sdk57');
const metadata = parseExportMetadata(await Bun.file(join(EXPORT_DIR, 'metadata.json')).text());
const expoConfig = parseExpoClientConfig(
  await Bun.file(join(EXPORT_DIR, 'expoConfig.json')).text(),
);

const UPDATE_ID = '0192f0c1-9c8e-7a3b-b4d2-1a2b3c4d5e6f';

async function readExportFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(EXPORT_DIR, path)).arrayBuffer());
}

/** Build a manifest from the real fixture, the way the importer will. */
async function buildFixtureManifest(platform: 'ios' | 'android') {
  const platformMeta = metadata.fileMetadata[platform];
  if (!platformMeta) throw new Error(`fixture has no ${platform} metadata`);

  const bundleBytes = await readExportFile(platformMeta.bundle);
  const bundleDigest = digestAsset(bundleBytes);

  const assets: ManifestAssetInput[] = [];
  for (const asset of platformMeta.assets) {
    const digest = digestAsset(await readExportFile(asset.path));
    assets.push({
      hash: digest.sha256Base64Url,
      key: digest.md5Hex,
      ext: asset.ext,
      url: `https://ota.example.com/api/v1/assets/${assetStorageKey(digest.sha256Hex)}`,
    });
  }

  return buildManifest({
    updateId: UPDATE_ID,
    createdAt: new Date('2026-08-10T12:00:00.000Z'),
    runtimeVersion: '1.0.0',
    launchAsset: {
      hash: bundleDigest.sha256Base64Url,
      key: bundleDigest.md5Hex,
      url: `https://ota.example.com/api/v1/assets/${assetStorageKey(bundleDigest.sha256Hex)}`,
    },
    assets,
    expoClientConfig: expoConfig,
  });
}

describe('hash encoding', () => {
  test('asset hashes are 43-char unpadded base64url', async () => {
    for (const platform of platformsInExport(metadata)) {
      const manifest = await buildFixtureManifest(platform);
      for (const asset of [manifest.launchAsset, ...manifest.assets]) {
        expect(asset.hash).toHaveLength(43);
        expect(asset.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(asset.hash).not.toContain('=');
        // base64url alphabet only: never the standard-base64 '+' or '/'.
        expect(asset.hash).not.toMatch(/[+/]/);
      }
    }
  });

  test('asset keys are 32-char hex MD5 and match the export filename', async () => {
    const platformMeta = metadata.fileMetadata.android!;
    for (const asset of platformMeta.assets) {
      const digest = digestAsset(await readExportFile(asset.path));
      expect(digest.md5Hex).toMatch(/^[0-9a-f]{32}$/);
      // Metro names the file after its hash, so our key lines up with what the
      // export already calls the asset.
      expect(asset.path).toBe(`assets/${digest.md5Hex}`);
    }
  });

  test('incremental hashing equals one-shot hashing', async () => {
    const bytes = await readExportFile(metadata.fileMetadata.ios!.bundle);
    const oneShot = sha256Base64Url(bytes);

    const digest = digestAsset(bytes);
    expect(digest.sha256Base64Url).toBe(oneShot);
    expect(digest.sha256Hex).toBe(sha256Hex(bytes));
    expect(digest.size).toBe(bytes.byteLength);
  });

  test('storage keys shard by the first two hex characters, POSIX-separated', () => {
    const hex = 'ab83a8201cdeadbeef';
    expect(assetStorageKey(hex)).toBe(`sha256/ab/${hex}`);
    expect(assetStorageKey(hex)).not.toContain('\\');
  });
});

describe('buildManifest', () => {
  test('produces a spec-shaped manifest from the real export', async () => {
    const manifest = await buildFixtureManifest('android');

    expect(isUuidFormatted(manifest.id)).toBe(true);
    expect(manifest.createdAt).toBe('2026-08-10T12:00:00.000Z');
    expect(manifest.runtimeVersion).toBe('1.0.0');
    expect(manifest.assets).toHaveLength(2);
    expect(Object.keys(manifest)).toEqual([
      'id',
      'createdAt',
      'runtimeVersion',
      'launchAsset',
      'assets',
      'metadata',
      'extra',
    ]);
  });

  test('launch asset is JavaScript with a .bundle extension', async () => {
    const manifest = await buildFixtureManifest('ios');
    expect(manifest.launchAsset.contentType).toBe('application/javascript');
    expect(manifest.launchAsset.fileExtension).toBe('.bundle');
    expect(manifest.launchAsset.url).toStartWith('https://');
  });

  test('assets get dot-prefixed extensions and derived content types', async () => {
    const manifest = await buildFixtureManifest('ios');
    for (const asset of manifest.assets) {
      expect(asset.fileExtension).toBe('.png');
      expect(asset.contentType).toBe('image/png');
    }
  });

  test('extra carries expoClient, not expoConfig', async () => {
    const manifest = await buildFixtureManifest('android');
    // `expoClient` is what expo-constants reads. The reference repo's JSDoc
    // says `expoConfig`; its code says `expoClient`, and the code is right.
    expect(manifest.extra).toHaveProperty('expoClient');
    expect(manifest.extra).not.toHaveProperty('expoConfig');
    expect((manifest.extra.expoClient as { runtimeVersion: string }).runtimeVersion).toBe('1.0.0');
  });

  test('lowercases the update id so it matches expo-current-update-id', () => {
    const manifest = buildManifest({
      updateId: '0192F0C1-9C8E-7A3B-B4D2-1A2B3C4D5E6F',
      createdAt: new Date(0),
      runtimeVersion: '1.0.0',
      launchAsset: { hash: 'h', key: 'k', url: 'u' },
      assets: [],
      expoClientConfig: {},
    });
    expect(manifest.id).toBe('0192f0c1-9c8e-7a3b-b4d2-1a2b3c4d5e6f');
  });

  test('rejects a non-UUID update id', () => {
    expect(() =>
      buildManifest({
        updateId: 'release-42',
        createdAt: new Date(0),
        runtimeVersion: '1.0.0',
        launchAsset: { hash: 'h', key: 'k', url: 'u' },
        assets: [],
        expoClientConfig: {},
      }),
    ).toThrow(/must be UUID-formatted/);
  });
});

describe('serializeManifest', () => {
  test('is stable across calls', async () => {
    const manifest = await buildFixtureManifest('ios');
    expect(serializeManifest(manifest)).toBe(serializeManifest(manifest));
  });

  test('round-trips to an equal object', async () => {
    const manifest = await buildFixtureManifest('ios');
    expect(JSON.parse(serializeManifest(manifest))).toEqual(manifest);
  });
});

describe('contentTypeForExtension', () => {
  test.each([
    ['png', 'image/png'],
    ['.png', 'image/png'],
    ['PNG', 'image/png'],
    ['ttf', 'font/ttf'],
    ['json', 'application/json'],
    ['mp4', 'video/mp4'],
    ['wat', 'application/octet-stream'],
    [null, 'application/octet-stream'],
  ])('%s -> %s', (ext, expected) => {
    expect(contentTypeForExtension(ext)).toBe(expected);
  });
});

describe('isUuidFormatted', () => {
  test.each([
    ['0192f0c1-9c8e-7a3b-b4d2-1a2b3c4d5e6f', true],
    // The reference server slices a SHA-256, so version/variant nibbles are
    // arbitrary. The client only needs the shape.
    ['ab83a820-1c9f-0000-ffff-0123456789ab', true],
    ['not-a-uuid', false],
    ['0192f0c19c8e7a3bb4d21a2b3c4d5e6f', false],
    ['', false],
  ])('%s -> %s', (id, expected) => {
    expect(isUuidFormatted(id)).toBe(expected);
  });
});
