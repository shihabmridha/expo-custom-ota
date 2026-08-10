import { unzipSync } from 'fflate';

/**
 * Safe ZIP reading.
 *
 * Two structural properties do most of the security work here:
 *
 *  1. Nothing is ever written to a filesystem. Entries are inflated in memory
 *     and pushed straight to object storage under a key derived from the hash
 *     we computed. There is no path to traverse into, so `../`, absolute paths
 *     and symlink entries have no target — they are inert data.
 *
 *  2. We read an allowlist of paths named in `metadata.json` rather than
 *     walking the archive, so an attacker cannot get us to touch an entry we
 *     did not already expect.
 *
 * The size limits below are enforced against the central directory *before*
 * decompression, and re-checked against actual inflated bytes afterwards — a
 * lying central directory must not win.
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryBytes: number;
  /** Uncompressed:compressed ratio above which an entry is treated as a bomb. */
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
  constructor(
    readonly code:
      | 'NOT_A_ZIP'
      | 'TOO_MANY_ENTRIES'
      | 'ENTRY_TOO_LARGE'
      | 'ARCHIVE_TOO_LARGE'
      | 'COMPRESSION_BOMB'
      | 'UNSAFE_ENTRY_NAME'
      | 'SIZE_MISMATCH'
      | 'MISSING_ENTRY',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reject entry names that have no business in an Expo export.
 *
 * Even though nothing is written to disk, a malformed name is a strong signal
 * of a hand-crafted archive, and rejecting early keeps the failure legible.
 */
export function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return true;
  // Control characters, including NUL — never legitimate in an export name.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }

  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  if (normalized.split('/').some((segment) => segment === '..')) return true;

  return false;
}

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipArchive {
  entries(): ZipEntryInfo[];
  has(name: string): boolean;
  /** Read one entry by exact (POSIX-normalised) name. */
  read(name: string): Uint8Array;
}

/**
 * Open an archive, validating the central directory against `limits` before any
 * entry is decompressed.
 */
export function openZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const infos: ZipEntryInfo[] = [];
  let totalUncompressed = 0;

  // fflate's `filter` receives central-directory metadata before inflating.
  // Returning false for everything gives a metadata-only pass.
  try {
    unzipSync(bytes, {
      filter: (info) => {
        if (info.name.endsWith('/')) return false; // directory entry

        if (isUnsafeEntryName(info.name)) {
          throw new ArchiveError(
            'UNSAFE_ENTRY_NAME',
            `Archive contains an unsafe entry name: ${JSON.stringify(info.name)}`,
          );
        }

        infos.push({
          name: info.name.replace(/\\/g, '/'),
          compressedSize: info.size,
          uncompressedSize: info.originalSize,
        });

        if (infos.length > limits.maxEntries) {
          throw new ArchiveError(
            'TOO_MANY_ENTRIES',
            `Archive contains more than ${limits.maxEntries} entries.`,
          );
        }

        if (info.originalSize > limits.maxEntryBytes) {
          throw new ArchiveError(
            'ENTRY_TOO_LARGE',
            `Entry "${info.name}" expands to ${info.originalSize} bytes, over the ${limits.maxEntryBytes} byte limit.`,
          );
        }

        totalUncompressed += info.originalSize;
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
          throw new ArchiveError(
            'ARCHIVE_TOO_LARGE',
            `Archive expands to more than ${limits.maxTotalUncompressedBytes} bytes.`,
          );
        }

        // Ratio check, skipped for small entries: tiny files routinely compress
        // to more than their original size, which would trip a naive ratio.
        if (info.originalSize > 4096 && info.size > 0) {
          const ratio = info.originalSize / info.size;
          if (ratio > limits.maxCompressionRatio) {
            throw new ArchiveError(
              'COMPRESSION_BOMB',
              `Entry "${info.name}" has a compression ratio of ${Math.round(ratio)}:1, over the ` +
                `${limits.maxCompressionRatio}:1 limit. This looks like a decompression bomb.`,
            );
          }
        }

        return false;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('NOT_A_ZIP', `Could not read archive: ${(error as Error).message}`);
  }

  const byName = new Map(infos.map((info) => [info.name, info]));

  return {
    entries: () => [...infos],
    has: (name) => byName.has(name),
    read(name) {
      const info = byName.get(name);
      if (!info) {
        throw new ArchiveError('MISSING_ENTRY', `Archive is missing "${name}".`);
      }

      // Inflate only this entry.
      const extracted = unzipSync(bytes, {
        filter: (candidate) => candidate.name.replace(/\\/g, '/') === name,
      });
      const data = extracted[name] ?? extracted[info.name];
      if (!data) {
        throw new ArchiveError('MISSING_ENTRY', `Archive is missing "${name}".`);
      }

      // The central directory is attacker-controlled; verify what we actually
      // got matches what it claimed.
      if (data.byteLength !== info.uncompressedSize) {
        throw new ArchiveError(
          'SIZE_MISMATCH',
          `Entry "${name}" declared ${info.uncompressedSize} bytes but inflated to ${data.byteLength}.`,
        );
      }
      if (data.byteLength > limits.maxEntryBytes) {
        throw new ArchiveError(
          'ENTRY_TOO_LARGE',
          `Entry "${name}" inflated to ${data.byteLength} bytes, over the limit.`,
        );
      }

      return data;
    },
  };
}
