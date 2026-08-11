/**
 * Hashing for the Expo Updates protocol.
 *
 * Two different encodings are in play and they are easy to confuse:
 *
 *   asset `hash`  → base64url SHA-256, padding stripped  (43 chars)
 *   `expo-signature` `sig` → standard base64, padded
 *
 * `Bun.CryptoHasher(...).digest('base64url')` already produces the unpadded
 * form, so no manual `+/=` transcoding is needed.
 */

export type HashInput = Uint8Array | ArrayBuffer | string;

/** Base64url SHA-256 with padding stripped — the manifest `asset.hash` format. */
export function sha256Base64Url(input: HashInput): string {
  return new Bun.CryptoHasher('sha256').update(input as never).digest('base64url');
}

/** Hex SHA-256 — used for storage keys and the uploaded archive's `source_hash`. */
export function sha256Hex(input: HashInput): string {
  return new Bun.CryptoHasher('sha256').update(input as never).digest('hex');
}

/**
 * Hex MD5 — the manifest `asset.key`.
 *
 * The spec permits any stable unique string, but the reference server uses hex
 * MD5, which also matches the `assets/<hash>` filename Metro writes into the
 * export. Matching it keeps our keys aligned with what tooling expects.
 */
export function md5Hex(input: HashInput): string {
  return new Bun.CryptoHasher('md5').update(input as never).digest('hex');
}

export interface AssetDigest {
  sha256Base64Url: string;
  sha256Hex: string;
  md5Hex: string;
  size: number;
}

/**
 * Incremental hasher producing every digest the importer needs in a single
 * pass over the bytes, so a large asset is never buffered twice.
 */
export function createAssetHasher(): {
  update(chunk: Uint8Array): void;
  digest(): AssetDigest;
} {
  const sha = new Bun.CryptoHasher('sha256');
  const md5 = new Bun.CryptoHasher('md5');
  let size = 0;

  return {
    update(chunk) {
      sha.update(chunk);
      md5.update(chunk);
      size += chunk.byteLength;
    },
    digest() {
      // `digest()` finalises the hasher, so each is read exactly once.
      const shaBytes = sha.digest();
      return {
        sha256Base64Url: Buffer.from(shaBytes).toString('base64url'),
        sha256Hex: Buffer.from(shaBytes).toString('hex'),
        md5Hex: md5.digest('hex'),
        size,
      };
    },
  };
}

/** Digest a whole buffer. Convenience wrapper over {@link createAssetHasher}. */
export function digestAsset(bytes: Uint8Array): AssetDigest {
  const hasher = createAssetHasher();
  hasher.update(bytes);
  return hasher.digest();
}

/**
 * Storage key for a content-addressed object: `sha256/<first-2-hex>/<full-hex>`.
 *
 * Always POSIX separators — a `path.join` on Windows would emit backslashes
 * into object storage keys and into signed manifest URLs.
 */
export function assetStorageKey(sha256HexDigest: string): string {
  return `sha256/${sha256HexDigest.slice(0, 2)}/${sha256HexDigest}`;
}
