import { describe, expect, test } from 'bun:test';
import { createApiClient } from '../src/index.ts';

/** Builds a stub `fetch` that returns `body` as JSON and records every request init. */
function stubFetch(body: unknown): { fetch: typeof fetch; calls: (RequestInit | undefined)[] } {
  const calls: (RequestInit | undefined)[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init);
    return Response.json(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const importResult = { releaseId: 'rel-1', releaseNumber: 1, importStatus: 'ready' };

describe('caller-supplied headers', () => {
  test('reach a binary upload alongside the contract content-type', async () => {
    const { fetch, calls } = stubFetch(importResult);
    const api = createApiClient({ fetch });

    await api.releases.import({
      params: { id: 'app-1' },
      query: { filename: 'update.zip' },
      rawBody: new Uint8Array([1, 2, 3]),
      headers: { 'idempotency-key': 'key-1' },
    });

    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('idempotency-key')).toBe('key-1');
    expect(headers.get('content-type')).toBe('application/zip');
    expect(calls[0]?.credentials).toBe('include');
  });

  test('survive the progress path, which falls back to fetch outside a browser', async () => {
    // There is no `XMLHttpRequest` global in Bun, so `onUploadProgress` cannot
    // take the XHR branch here — this covers only the fallback.
    const { fetch, calls } = stubFetch(importResult);
    const api = createApiClient({ fetch });

    await api.releases.import({
      params: { id: 'app-1' },
      query: { filename: 'update.zip' },
      rawBody: new Uint8Array([1, 2, 3]),
      headers: { 'idempotency-key': 'key-2' },
      onUploadProgress: () => {},
    });

    expect(new Headers(calls[0]?.headers).get('idempotency-key')).toBe('key-2');
  });

  test('cannot override the content-type, whatever the casing', async () => {
    const { fetch, calls } = stubFetch(importResult);
    const api = createApiClient({ fetch });

    await api.releases.import({
      params: { id: 'app-1' },
      query: { filename: 'update.zip' },
      rawBody: new Uint8Array([1, 2, 3]),
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(new Headers(calls[0]?.headers).get('content-type')).toBe('application/zip');
  });

  test('reach a JSON route without disturbing its body or content-type', async () => {
    const { fetch, calls } = stubFetch({
      deploymentId: 'dep-1',
      channel: 'production',
      updates: [],
    });
    const api = createApiClient({ fetch, validateResponses: false });

    await api.releases.publish({
      params: { releaseId: 'rel-1' },
      body: { channel: 'production' },
      headers: { 'idempotency-key': 'key-3' },
    });

    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('idempotency-key')).toBe('key-3');
    expect(headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.body).toBe(JSON.stringify({ channel: 'production' }));
  });

  test('a request with no caller headers and no body sends none', async () => {
    const { fetch, calls } = stubFetch({ ok: true });
    const api = createApiClient({ fetch, validateResponses: false });

    await api.auth.logout();

    expect(calls[0]?.headers).toBeUndefined();
  });
});
