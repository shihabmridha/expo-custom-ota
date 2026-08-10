/**
 * Content-addressed object storage.
 *
 * Objects are immutable and keyed by the SHA-256 of their contents, so the same
 * physical object is shared across releases, runtime versions and applications.
 * `get`/`stat` are additions over the spec's interface — the local dev driver
 * must be able to serve bytes back.
 */
export interface AssetStorage {
  exists(key: string): Promise<boolean>;

  put(
    key: string,
    data: Blob | ReadableStream<Uint8Array> | Uint8Array,
    options: { contentType: string; cacheControl?: string },
  ): Promise<void>;

  get(key: string): Promise<ReadableStream<Uint8Array> | null>;

  stat(key: string): Promise<{ size: number; contentType?: string } | null>;

  /** Absolute URL. Baked into signed manifests, so it must be stable. */
  getPublicUrl(key: string): string;

  delete(key: string): Promise<void>;
}
