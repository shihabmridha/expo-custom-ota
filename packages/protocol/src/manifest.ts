import type { ExpoAsset, ExpoClientConfig, ExpoManifest } from '@ota/types';
import { CT_JAVASCRIPT } from './headers.ts';

/**
 * Manifest construction.
 *
 * The critical rule: {@link serializeManifest} is called **once** per manifest,
 * and that exact string is both signed and stored. The protocol has no
 * canonicalization step, so a re-serialization with different key order or
 * whitespace silently invalidates the signature.
 */

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client parses `manifest.id` with `UUID.fromString`, so it must be
 * UUID-*formatted*. It need not be a valid RFC 4122 version — the reference
 * server slices a SHA-256 into 8-4-4-4-12 — but the shape is mandatory.
 */
export function isUuidFormatted(id: string): boolean {
  return UUID_FORMAT.test(id);
}

export interface ManifestAssetInput {
  /** Base64url SHA-256, unpadded. */
  hash: string;
  /** Hex MD5 in our importer, matching the reference server. */
  key: string;
  /** Metro asset type with no leading dot, e.g. `png`. Absent for the launch asset. */
  ext?: string | null;
  /** Absolute URL. */
  url: string;
  /** Overrides the extension-derived MIME type when known. */
  contentType?: string;
}

export interface BuildManifestInput {
  updateId: string;
  createdAt: Date;
  runtimeVersion: string;
  launchAsset: ManifestAssetInput;
  assets: ManifestAssetInput[];
  expoClientConfig: ExpoClientConfig;
  metadata?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Minimal extension → MIME map.
 *
 * Deliberately not a `mime` dependency: an Expo export contains a small, known
 * set of asset types, and an unknown extension falling back to
 * `application/octet-stream` is correct behaviour — the client uses `hash` for
 * integrity and only needs `contentType` as a save hint.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject',
  json: 'application/json',
  js: 'application/javascript',
  hbc: 'application/javascript',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  zip: 'application/zip',
  lottie: 'application/json',
  riv: 'application/octet-stream',
};

export function contentTypeForExtension(ext: string | null | undefined): string {
  if (!ext) return 'application/octet-stream';
  return MIME_BY_EXTENSION[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

function buildAsset(input: ManifestAssetInput, isLaunchAsset: boolean): ExpoAsset {
  return {
    hash: input.hash,
    key: input.key,
    // The launch asset is always JS, and the reference server sends `.bundle`
    // even though the spec says to omit it. The client ignores the field for
    // the launch asset either way; we match the reference server.
    contentType: isLaunchAsset
      ? CT_JAVASCRIPT
      : (input.contentType ?? contentTypeForExtension(input.ext)),
    fileExtension: isLaunchAsset ? '.bundle' : `.${(input.ext ?? '').replace(/^\./, '')}`,
    url: input.url,
  };
}

export function buildManifest(input: BuildManifestInput): ExpoManifest {
  if (!isUuidFormatted(input.updateId)) {
    throw new Error(
      `Manifest id must be UUID-formatted (the client calls UUID.fromString); got "${input.updateId}".`,
    );
  }

  return {
    id: input.updateId.toLowerCase(),
    createdAt: input.createdAt.toISOString(),
    runtimeVersion: input.runtimeVersion,
    launchAsset: buildAsset(input.launchAsset, true),
    assets: input.assets.map((asset) => buildAsset(asset, false)),
    metadata: input.metadata ?? {},
    extra: {
      // `expoClient` — NOT `expoConfig`. This is what `expo-constants` reads to
      // populate `Constants.expoConfig` on device. The reference repo's own
      // JSDoc says `expoConfig`; its code says `expoClient`, and the code wins.
      expoClient: input.expoClientConfig,
      ...input.extra,
    },
  };
}

/**
 * Serialize a manifest to the bytes that will be signed AND sent.
 *
 * Call this once. Store the result. Never re-derive it from a parsed object.
 */
export function serializeManifest(manifest: ExpoManifest): string {
  return JSON.stringify(manifest);
}
