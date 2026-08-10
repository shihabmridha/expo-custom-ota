/**
 * Wire types for the Expo Updates v1 protocol.
 *
 * See `docs/protocol-notes.md`. These shapes are dictated by the client; do not
 * "improve" them.
 */

export interface ExpoAsset {
  /** Base64url-encoded SHA-256 of the raw file bytes, padding stripped (43 chars). */
  hash?: string;
  /**
   * Key used to reference this asset from application code. The reference
   * server uses hex MD5 of the file bytes, which also matches the
   * `assets/<hash>` filename in an `expo export`.
   */
  key: string;
  /** MIME type. The launch asset is always `application/javascript`. */
  contentType: string;
  /** Suggested save extension, dot-prefixed. The launch asset gets `.bundle`. */
  fileExtension?: string;
  /** Absolute URL the client fetches the bytes from. */
  url: string;
}

export interface ExpoManifest {
  /** MUST be UUID-formatted — the client parses it with `UUID.fromString`. */
  id: string;
  /** ISO 8601. */
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ExpoAsset;
  assets: ExpoAsset[];
  /** String-valued; filtered against the `expo-manifest-filters` response header. */
  metadata: Record<string, string>;
  /** Carries `expoClient` — the public Expo config that populates `Constants.expoConfig`. */
  extra: Record<string, unknown>;
}

/** Body of the `extensions` multipart part. */
export interface ExpoExtensions {
  assetRequestHeaders: Record<string, Record<string, string>>;
}

export type ExpoDirectiveType = 'noUpdateAvailable' | 'rollBackToEmbedded';

export interface ExpoDirective {
  type: ExpoDirectiveType;
  parameters?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface NoUpdateAvailableDirective extends ExpoDirective {
  type: 'noUpdateAvailable';
}

export interface RollBackToEmbeddedDirective extends ExpoDirective {
  type: 'rollBackToEmbedded';
  parameters: { commitTime: string };
}

/** Recognised multipart part names. `certificate_chain` is undocumented but parsed by the client. */
export const MULTIPART_PART_NAMES = [
  'manifest',
  'extensions',
  'directive',
  'certificate_chain',
] as const;

export type MultipartPartName = (typeof MULTIPART_PART_NAMES)[number];

/** The only signing algorithm the client supports. */
export const CODE_SIGNING_ALGORITHM = 'rsa-v1_5-sha256';
