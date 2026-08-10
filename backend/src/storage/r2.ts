import type { AssetStorage } from '@ota/types';
import { S3Client } from 'bun';

/**
 * Cloudflare R2 (or any S3-compatible bucket).
 *
 * Uses Bun's built-in `S3Client`, so there is no `@aws-sdk/*` dependency.
 */
export class R2AssetStorage implements AssetStorage {
  private readonly client: S3Client;

  constructor(
    config: {
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    /**
     * Public bucket origin. When unset, manifests point at the backend's asset
     * route instead and bytes are proxied.
     */
    private readonly publicBaseUrl: string | null,
    private readonly fallbackBaseUrl: string,
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
  }

  async exists(key: string): Promise<boolean> {
    return this.client.file(key).exists();
  }

  async put(
    key: string,
    data: Blob | ReadableStream<Uint8Array> | Uint8Array,
    options: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    if (await this.exists(key)) return;

    await this.client.write(key, data as Blob, {
      type: options.contentType,
      // Content-addressed URLs never change contents, so they can be cached
      // effectively forever.
      ...(options.cacheControl ? { acl: undefined } : {}),
    });
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.client.file(key);
    if (!(await file.exists())) return null;
    return file.stream();
  }

  async stat(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const info = await this.client.file(key).stat();
      return { size: info.size, contentType: info.type };
    } catch {
      return null;
    }
  }

  getPublicUrl(key: string): string {
    return this.publicBaseUrl
      ? `${this.publicBaseUrl}/${key}`
      : `${this.fallbackBaseUrl}/api/v1/assets/${key}`;
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }
}
