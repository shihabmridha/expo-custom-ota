import type { Platform } from './platform.ts';

/**
 * Shape of `metadata.json` inside an `expo export` output directory.
 *
 * `version` is always 0 and `bundler` always "metro" for current SDKs. `web` is
 * excluded from `fileMetadata` by the CLI. `assets` may legitimately be empty:
 * SDK 52+ omits assets already embedded in the native binary.
 */
export interface ExportPlatformMetadataAsset {
  /** Always `assets/<hash>`, POSIX separators. */
  path: string;
  /** Metro asset type with **no** leading dot, e.g. `png`, `ttf`. */
  ext: string;
}

export interface ExportPlatformMetadata {
  /**
   * Relative path within `dist/` of the JS bundle, e.g.
   * `_expo/static/js/ios/entry-<hash>.hbc`. The extension is `.hbc` or `.js`
   * depending on SDK version — always read it, never derive it.
   */
  bundle: string;
  assets: ExportPlatformMetadataAsset[];
}

export interface ExportMetadata {
  version: 0;
  bundler: 'metro';
  fileMetadata: Partial<Record<Platform, ExportPlatformMetadata>>;
}

/**
 * The public Expo config, produced by `@expo/config`'s
 * `getConfig(dir, { isPublicConfig: true })`.
 *
 * `expo export` does NOT emit this — the `expo-custom-ota` CLI generates it
 * during `pack`, and the importer requires it in the archive, because it
 * becomes `manifest.extra.expoClient` and is what populates
 * `Constants.expoConfig`.
 */
export interface ExpoClientConfig {
  name?: string;
  slug?: string;
  version?: string;
  runtimeVersion?: string | { policy: string };
  sdkVersion?: string;
  android?: { package?: string; runtimeVersion?: string | { policy: string } };
  ios?: { bundleIdentifier?: string; runtimeVersion?: string | { policy: string } };
  updates?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Canonical file names expected at the root of an upload archive. */
export const EXPORT_METADATA_FILENAME = 'metadata.json';
export const EXPO_CONFIG_FILENAME = 'expoConfig.json';
