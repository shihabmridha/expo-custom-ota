import { type ApiClient, ApiError, createApiClient } from '@ota/api-client';
import { withCookieJar } from './cookie-jar.ts';
import type { ImportReleaseResult, ReleaseDetail } from './types.ts';

export { ApiError } from '@ota/api-client';
export type * from './types.ts';

/**
 * Ergonomic wrapper over the typed client.
 *
 * The dashboard uses `@ota/api-client` directly with TanStack Query; this layer
 * exists for scripts and a future publishing CLI, where "upload, wait, publish"
 * as one call is what you actually want.
 */
export interface OtaClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class OtaClient {
  readonly api: ApiClient;

  constructor(options: OtaClientOptions) {
    this.api = createApiClient({
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      fetch: withCookieJar(options.fetch ?? globalThis.fetch.bind(globalThis)),
    });
  }

  async login(email: string, password: string) {
    return this.api.auth.login({ body: { email, password } });
  }

  /** Upload an export archive. Returns as soon as the import is accepted. */
  async uploadRelease(
    applicationId: string,
    archive: Blob | Uint8Array,
    options: {
      message?: string;
      filename?: string;
      /**
       * Sent as `idempotency-key`. Defaults to a fresh UUID, so a redelivered
       * upload resolves to the release it already created; pass your own to
       * make a retry across process invocations idempotent too.
       */
      idempotencyKey?: string;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<ImportReleaseResult> {
    return this.api.releases.import({
      params: { id: applicationId },
      query: {
        ...(options.message ? { message: options.message } : {}),
        ...(options.filename ? { filename: options.filename } : {}),
      },
      rawBody: archive,
      headers: { 'idempotency-key': options.idempotencyKey ?? crypto.randomUUID() },
      ...(options.onProgress ? { onUploadProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * Poll until the import reaches a terminal state.
   *
   * Importing is asynchronous — hashing and uploading a few hundred assets
   * takes longer than a request should — so the upload returns immediately and
   * progress is polled.
   */
  async waitForImport(
    releaseId: string,
    options: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ReleaseDetail> {
    const { pollMs = 1000, timeoutMs = 300_000, signal } = options;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const release = await this.api.releases.get({
        params: { releaseId },
        ...(signal ? { signal } : {}),
      });

      if (release.importStatus === 'ready') return release;
      if (release.importStatus === 'failed') {
        throw new ApiError(
          422,
          'IMPORT_FAILED',
          release.importError ?? 'Release import failed for an unknown reason',
        );
      }

      if (Date.now() > deadline) {
        throw new ApiError(
          504,
          'IMPORT_TIMEOUT',
          `Import did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ${release.importStatus})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Upload, wait for the import, then publish — the whole normal flow. */
  async importAndPublish(
    applicationId: string,
    archive: Blob | Uint8Array,
    options: {
      channel: string;
      message?: string;
      filename?: string;
      idempotencyKey?: string;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    },
  ) {
    const imported = await this.uploadRelease(applicationId, archive, options);
    await this.waitForImport(imported.releaseId, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.api.releases.publish({
      params: { releaseId: imported.releaseId },
      body: { channel: options.channel },
    });
  }
}
