import { type ExpoClientConfig, type ExportMetadata, PLATFORMS, type Platform } from '@ota/types';
import { z } from 'zod';

/**
 * Parsing and validation of an `expo export` output.
 *
 * Everything here reads values rather than deriving them: the bundle filename
 * and extension (`.hbc` vs `.js`) are not stable across SDK versions, and asset
 * extensions live only in `metadata.json`.
 */

/**
 * Normalise an archive path to POSIX separators.
 *
 * `@expo/cli`'s `createMetadataJson` builds asset paths with `path.join`, which
 * emits **backslashes on Windows** — a real export produced there contains
 * `"path": "assets\\cb975bba..."`. ZIP entry names are always forward-slashed,
 * so matching the raw value would find nothing. Verified against a real SDK 57
 * export on Windows.
 */
export function normalizeExportPath(path: string): string {
  return path.replace(/\\/g, '/');
}

const platformMetadataSchema = z.object({
  bundle: z.string().min(1).transform(normalizeExportPath),
  assets: z.array(
    z.object({
      path: z.string().min(1).transform(normalizeExportPath),
      // Metro writes the extension with no leading dot.
      ext: z.string(),
    }),
  ),
});

export const exportMetadataSchema = z.object({
  version: z.literal(0),
  bundler: z.literal('metro'),
  fileMetadata: z
    .object({
      ios: platformMetadataSchema.optional(),
      android: platformMetadataSchema.optional(),
      // `web` is excluded from OTA; tolerate and ignore it.
      web: z.unknown().optional(),
    })
    .passthrough(),
});

export function parseExportMetadata(raw: string): ExportMetadata {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`metadata.json is not valid JSON: ${(cause as Error).message}`);
  }

  const result = exportMetadataSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`metadata.json failed validation: ${issues}`);
  }

  const { ios, android } = result.data.fileMetadata;
  return {
    version: 0,
    bundler: 'metro',
    fileMetadata: {
      ...(ios ? { ios } : {}),
      ...(android ? { android } : {}),
    },
  };
}

/** Platforms actually present in an export, in stable order. */
export function platformsInExport(metadata: ExportMetadata): Platform[] {
  return PLATFORMS.filter((p) => metadata.fileMetadata[p] !== undefined);
}

/**
 * Every archive path an export references, for the given platforms.
 *
 * The importer reads only these paths by exact match rather than walking the
 * archive — an allowlist, which structurally rules out traversal entries,
 * absolute paths and symlinks instead of trying to sanitize them.
 */
export function referencedPaths(metadata: ExportMetadata, platforms: Platform[]): Set<string> {
  const paths = new Set<string>();
  for (const platform of platforms) {
    const meta = metadata.fileMetadata[platform];
    if (!meta) continue;
    paths.add(meta.bundle);
    for (const asset of meta.assets) paths.add(asset.path);
  }
  return paths;
}

export function parseExpoClientConfig(raw: string): ExpoClientConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`expoConfig.json is not valid JSON: ${(cause as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('expoConfig.json must contain a JSON object.');
  }
  return json as ExpoClientConfig;
}

/**
 * Resolve the runtime version for a platform from the public Expo config.
 *
 * Runtime version does not appear in `metadata.json`. A `{ policy }` value
 * cannot be resolved server-side — it is computed at native build time from the
 * project's native state — so we reject it with an actionable message rather
 * than guessing.
 */
export function resolveRuntimeVersion(config: ExpoClientConfig, platform: Platform): string {
  const candidate = config[platform]?.runtimeVersion ?? config.runtimeVersion;

  if (typeof candidate === 'string' && candidate.length > 0) return candidate;

  if (candidate && typeof candidate === 'object' && 'policy' in candidate) {
    throw new Error(
      `runtimeVersion policy "${candidate.policy}" cannot be resolved by the server. ` +
        'Set an explicit runtimeVersion string in your app config, or resolve the policy ' +
        'locally before packing the update.',
    );
  }

  throw new Error(
    `No runtimeVersion found for platform "${platform}" in expoConfig.json. ` +
      'Set expo.runtimeVersion (or expo.' +
      platform +
      '.runtimeVersion) to an explicit string.',
  );
}

/**
 * Compare the uploaded config's native identifiers against the application's
 * stored ones.
 *
 * This is the check that stops an update for one app being published into
 * another in a multi-application platform. Returns a human-readable problem, or
 * null when the identity matches (or when nothing is configured to compare).
 */
export function checkApplicationIdentity(
  config: ExpoClientConfig,
  expected: { androidPackage?: string | null; iosBundleIdentifier?: string | null },
  platforms: Platform[],
): string | null {
  if (platforms.includes('android') && expected.androidPackage) {
    const uploaded = config.android?.package;
    if (uploaded && uploaded !== expected.androidPackage) {
      return (
        'This update appears to belong to another application.\n\n' +
        `Expected Android package:\n${expected.androidPackage}\n\n` +
        `Uploaded Android package:\n${uploaded}`
      );
    }
  }

  if (platforms.includes('ios') && expected.iosBundleIdentifier) {
    const uploaded = config.ios?.bundleIdentifier;
    if (uploaded && uploaded !== expected.iosBundleIdentifier) {
      return (
        'This update appears to belong to another application.\n\n' +
        `Expected iOS bundle identifier:\n${expected.iosBundleIdentifier}\n\n` +
        `Uploaded iOS bundle identifier:\n${uploaded}`
      );
    }
  }

  return null;
}
