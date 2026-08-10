import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AssetStorage } from '@ota/types';

/**
 * Filesystem-backed object storage for development.
 *
 * Objects are immutable and content-addressed, so a write whose key already
 * exists is a no-op rather than an overwrite — which also sidesteps Windows'
 * refusal to rename over an existing file.
 */
export class LocalAssetStorage implements AssetStorage {
  constructor(
    private readonly rootDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  /**
   * Map a storage key to a path, refusing anything that escapes the root.
   *
   * Keys are generated from hashes we compute, so traversal should be
   * impossible — but this is cheap and turns a future bug into an error rather
   * than a write outside the storage directory.
   */
  private pathFor(key: string): string {
    const target = resolve(this.rootDir, key);
    const root = resolve(this.rootDir);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return target;
  }

  async exists(key: string): Promise<boolean> {
    return Bun.file(this.pathFor(key)).exists();
  }

  async put(
    key: string,
    data: Blob | ReadableStream<Uint8Array> | Uint8Array,
    _options: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    const path = this.pathFor(key);

    // Content-addressed: identical key means identical bytes, so re-writing
    // would be pointless work and a needless chance to corrupt a good object.
    if (await Bun.file(path).exists()) return;

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, data as Blob);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const file = Bun.file(this.pathFor(key));
    if (!(await file.exists())) return null;
    return file.stream();
  }

  async stat(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { size: info.size };
    } catch {
      return null;
    }
  }

  getPublicUrl(key: string): string {
    // Keys are already POSIX-separated; never run them through path.join.
    return `${this.publicBaseUrl}/api/v1/assets/${key}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Absolute path of an object, for tests and diagnostics. */
  absolutePathFor(key: string): string {
    return join(this.rootDir, key);
  }
}
