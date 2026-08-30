import {
  buildPath,
  contracts,
  type ErrorResponse,
  type PathParams,
  type RouteBody,
  type RouteDef,
  type RoutePath,
  type RouteQuery,
  type RouteResponse,
} from '@ota/contracts';

/**
 * Typed API client, derived entirely from the contract registry.
 *
 * Adding a route to `@ota/contracts` adds a typed method here with no edit to
 * this file.
 */

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }

  /** True when the session is missing or expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type HasKeys<T> = keyof T extends never ? false : true;

/** Only require `params`/`body`/`query` when the route actually has them. */
type CallArgs<R> = (HasKeys<PathParams<RoutePath<R>>> extends true
  ? { params: PathParams<RoutePath<R>> }
  : { params?: undefined }) &
  ([RouteBody<R>] extends [never] ? { body?: undefined } : { body: RouteBody<R> }) &
  ([RouteQuery<R>] extends [never] ? { query?: undefined } : { query?: RouteQuery<R> }) & {
    signal?: AbortSignal;
    /**
     * Upload progress. `fetch` cannot report it, so supplying this switches the
     * request to XMLHttpRequest — the only reason that code path exists.
     * Browser-only: there is no `XMLHttpRequest` global in Node or Bun, so
     * outside a browser this is silently ignored and the request falls back to
     * plain `fetch` with no progress events.
     */
    onUploadProgress?: (loaded: number, total: number) => void;
    /** Raw body for `contentType: 'binary'` routes. */
    rawBody?: Blob | ArrayBuffer | Uint8Array;
    /**
     * Extra request headers — `idempotency-key` on a release upload is the only
     * current caller. The client's own `content-type` always wins: it is
     * dictated by the contract, not by the caller.
     */
    headers?: Record<string, string>;
  };

/**
 * Whether the caller must pass an argument at all.
 *
 * `CallArgs` always carries optional members (`signal`, `onUploadProgress`), so
 * testing `keyof CallArgs` is never empty — the question is specifically whether
 * path parameters or a body are required.
 */
type RequiresArgs<R> =
  HasKeys<PathParams<RoutePath<R>>> extends true
    ? true
    : [RouteBody<R>] extends [never]
      ? false
      : true;

type ClientMethod<R> =
  RequiresArgs<R> extends true
    ? (args: CallArgs<R>) => Promise<RouteResponse<R>>
    : (args?: CallArgs<R>) => Promise<RouteResponse<R>>;

type ClientGroup<G> = {
  [K in keyof G]: ClientMethod<G[K]>;
};

export type ApiClient = {
  [G in keyof typeof contracts]: ClientGroup<(typeof contracts)[G]>;
};

export interface ApiClientOptions {
  /** Empty string in dev and prod — the SPA is served same-origin. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Parse responses against the contract's schema. On by default: payloads are
   * small and it surfaces backend drift immediately rather than as a confusing
   * render error.
   */
  validateResponses?: boolean;
}

function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: Partial<ErrorResponse> = {};
  try {
    body = (await response.json()) as Partial<ErrorResponse>;
  } catch {
    // Non-JSON error (a proxy, a crash) — fall through to the status text.
  }
  return new ApiError(
    response.status,
    body.code ?? `HTTP_${response.status}`,
    body.message ?? response.statusText ?? 'Request failed',
    body.fieldErrors,
  );
}

/**
 * Merge caller-supplied headers underneath the client's own.
 *
 * A caller header that collides with one of ours is dropped rather than merged,
 * whatever its casing: header names are case-insensitive, so `Content-Type` and
 * `content-type` in the same object would otherwise reach the server as one
 * comma-joined value.
 */
function mergeHeaders(
  caller: Record<string, string> | undefined,
  own: Record<string, string>,
): Record<string, string> {
  if (!caller) return own;
  const reserved = new Set(Object.keys(own).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(caller)) {
    if (!reserved.has(name.toLowerCase())) merged[name] = value;
  }
  return { ...merged, ...own };
}

/**
 * Upload with progress via XMLHttpRequest.
 *
 * `fetch` genuinely cannot report upload progress in browsers, and the release
 * upload is the one place where a progress bar matters. Confined to this
 * function. Browser-only — callers must guard with `typeof XMLHttpRequest !==
 * 'undefined'` before reaching here, since no such global exists in Node or Bun.
 */
function xhrUpload(
  url: string,
  method: string,
  body: Blob | ArrayBuffer | Uint8Array,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () =>
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: { 'content-type': xhr.getResponseHeader('content-type') ?? 'application/json' },
        }),
      );
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload aborted'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const {
    baseUrl = '',
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    validateResponses = true,
  } = options;

  async function call(
    // biome-ignore lint/suspicious/noExplicitAny: ApiClient types the public surface; the dispatcher is necessarily dynamic.
    contract: RouteDef<any, any, any, any, any>,
    args: {
      params?: Record<string, string>;
      body?: unknown;
      query?: Record<string, unknown>;
      signal?: AbortSignal;
      onUploadProgress?: (loaded: number, total: number) => void;
      rawBody?: Blob | ArrayBuffer | Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const url = `${baseUrl}${buildPath(contract.path, args.params ?? {})}${buildQueryString(args.query)}`;

    let response: Response;

    if (contract.contentType === 'binary') {
      const payload = args.rawBody ?? (args.body as Blob | undefined);
      if (!payload) throw new ApiError(0, 'BAD_REQUEST', 'This route requires a rawBody');

      const headers = mergeHeaders(args.headers, { 'content-type': 'application/zip' });

      response =
        args.onUploadProgress && typeof XMLHttpRequest !== 'undefined'
          ? await xhrUpload(
              url,
              contract.method,
              payload,
              headers,
              args.onUploadProgress,
              args.signal,
            )
          : await fetchImpl(url, {
              method: contract.method,
              credentials: 'include',
              headers,
              body: payload as BodyInit,
              ...(args.signal ? { signal: args.signal } : {}),
            });
    } else {
      const headers = mergeHeaders(
        args.headers,
        args.body !== undefined ? { 'content-type': 'application/json' } : {},
      );

      response = await fetchImpl(url, {
        method: contract.method,
        credentials: 'include',
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });
    }

    if (!response.ok) throw await toApiError(response);

    if (response.status === 204) return undefined;

    const json = await response.json();
    if (!validateResponses) return json;

    const parsed = contract.response.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        'RESPONSE_VALIDATION',
        `Response from ${contract.method} ${contract.path} did not match its contract: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  const client = {} as Record<string, Record<string, unknown>>;
  for (const [groupName, group] of Object.entries(contracts)) {
    client[groupName] = {};
    for (const [routeName, contract] of Object.entries(group)) {
      client[groupName]![routeName] = (args: Parameters<typeof call>[1]) => call(contract, args);
    }
  }

  return client as unknown as ApiClient;
}
