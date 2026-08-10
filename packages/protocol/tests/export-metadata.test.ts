import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkApplicationIdentity,
  normalizeExportPath,
  parseExpoClientConfig,
  parseExportMetadata,
  platformsInExport,
  referencedPaths,
  resolveRuntimeVersion,
} from '../src/export-metadata.ts';
import { FIXTURES_DIR } from './helpers.ts';

const EXPORT_DIR = join(FIXTURES_DIR, 'expo-export-sdk57');

const metadata = parseExportMetadata(await Bun.file(join(EXPORT_DIR, 'metadata.json')).text());
const expoConfig = parseExpoClientConfig(
  await Bun.file(join(EXPORT_DIR, 'expoConfig.json')).text(),
);

describe('parseExportMetadata (real SDK 57 export)', () => {
  test('parses version and bundler', () => {
    expect(metadata.version).toBe(0);
    expect(metadata.bundler).toBe('metro');
  });

  test('finds both platforms', () => {
    expect(platformsInExport(metadata)).toEqual(['ios', 'android']);
  });

  test('reads the bundle path rather than deriving it', () => {
    // The real filename is `index-<hash>.hbc`, not the widely-documented
    // `entry-<hash>.hbc`. Deriving it would break against real exports.
    for (const platform of ['ios', 'android'] as const) {
      const bundle = metadata.fileMetadata[platform]?.bundle;
      expect(bundle).toMatch(
        new RegExp(`^_expo/static/js/${platform}/index-[0-9a-f]+\\.(hbc|js)$`),
      );
    }
  });

  test('normalises Windows backslash asset paths to POSIX', () => {
    for (const platform of ['ios', 'android'] as const) {
      for (const asset of metadata.fileMetadata[platform]?.assets ?? []) {
        expect(asset.path).not.toContain('\\');
        expect(asset.path).toMatch(/^assets\/[0-9a-f]{32}$/);
        // Metro writes extensions with no leading dot.
        expect(asset.ext).not.toStartWith('.');
      }
    }
  });

  test('every referenced path exists in the export', async () => {
    const paths = referencedPaths(metadata, platformsInExport(metadata));
    expect(paths.size).toBeGreaterThan(0);
    for (const path of paths) {
      expect(await Bun.file(join(EXPORT_DIR, path)).exists()).toBe(true);
    }
  });

  test('deduplicates assets shared between platforms', () => {
    const all = (['ios', 'android'] as const).flatMap(
      (p) => metadata.fileMetadata[p]?.assets.map((a) => a.path) ?? [],
    );
    const paths = referencedPaths(metadata, ['ios', 'android']);
    // Both platforms reference the same two images, so the set is smaller.
    expect(paths.size).toBeLessThan(all.length + 2);
  });
});

describe('parseExportMetadata validation', () => {
  test('tolerates an empty assets array', () => {
    // SDK 52+ omits assets already embedded in the native binary.
    const parsed = parseExportMetadata(
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { android: { bundle: 'b.hbc', assets: [] } },
      }),
    );
    expect(parsed.fileMetadata.android?.assets).toEqual([]);
  });

  test('ignores a web key', () => {
    const parsed = parseExportMetadata(
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: {
          ios: { bundle: 'b.hbc', assets: [] },
          web: { bundle: 'w.js', assets: [] },
        },
      }),
    );
    expect(platformsInExport(parsed)).toEqual(['ios']);
    expect('web' in parsed.fileMetadata).toBe(false);
  });

  test.each([
    ['malformed JSON', 'not json', 'not valid JSON'],
    [
      'wrong version',
      JSON.stringify({ version: 1, bundler: 'metro', fileMetadata: {} }),
      'failed validation',
    ],
    [
      'missing bundle',
      JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { ios: { assets: [] } } }),
      'failed validation',
    ],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => parseExportMetadata(input)).toThrow(expected);
  });
});

describe('normalizeExportPath', () => {
  test.each([
    ['assets\\abc', 'assets/abc'],
    ['assets/abc', 'assets/abc'],
    ['_expo\\static\\js\\ios\\b.hbc', '_expo/static/js/ios/b.hbc'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeExportPath(input)).toBe(expected);
  });
});

describe('resolveRuntimeVersion', () => {
  test('reads the explicit string from the real fixture', () => {
    expect(resolveRuntimeVersion(expoConfig, 'ios')).toBe('1.0.0');
    expect(resolveRuntimeVersion(expoConfig, 'android')).toBe('1.0.0');
  });

  test('prefers a platform-specific override', () => {
    expect(
      resolveRuntimeVersion({ runtimeVersion: '1.0.0', ios: { runtimeVersion: '2.0.0' } }, 'ios'),
    ).toBe('2.0.0');
  });

  test('rejects a policy with an actionable message', () => {
    expect(() =>
      resolveRuntimeVersion({ runtimeVersion: { policy: 'appVersion' } }, 'ios'),
    ).toThrow(/policy "appVersion" cannot be resolved by the server/);
  });

  test('rejects a missing runtime version', () => {
    expect(() => resolveRuntimeVersion({}, 'android')).toThrow(/No runtimeVersion found/);
  });
});

describe('checkApplicationIdentity', () => {
  test('accepts a matching identity', () => {
    expect(
      checkApplicationIdentity(
        expoConfig,
        { androidPackage: 'xyz.oat.fixture', iosBundleIdentifier: 'xyz.oat.fixture' },
        ['ios', 'android'],
      ),
    ).toBe(null);
  });

  test('rejects a mismatched Android package, naming both values', () => {
    const problem = checkApplicationIdentity(
      expoConfig,
      { androidPackage: 'xyz.acadion.mobile', iosBundleIdentifier: null },
      ['android'],
    );
    expect(problem).toContain('another application');
    expect(problem).toContain('xyz.acadion.mobile');
    expect(problem).toContain('xyz.oat.fixture');
  });

  test('rejects a mismatched iOS bundle identifier', () => {
    const problem = checkApplicationIdentity(
      expoConfig,
      { androidPackage: null, iosBundleIdentifier: 'com.example.other' },
      ['ios'],
    );
    expect(problem).toContain('com.example.other');
  });

  test('ignores platforms not present in the upload', () => {
    expect(
      checkApplicationIdentity(expoConfig, { androidPackage: 'com.totally.different' }, ['ios']),
    ).toBe(null);
  });

  test('skips the check when the application has no configured identifiers', () => {
    expect(checkApplicationIdentity(expoConfig, {}, ['ios', 'android'])).toBe(null);
  });
});
