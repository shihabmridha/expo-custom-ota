/**
 * A minimal cookie jar for `fetch`, keyed by request origin.
 *
 * Browsers keep their own cookie store: `credentials: 'include'` is enough to
 * send the session cookie `login()` sets and to have the browser store the
 * next `Set-Cookie` automatically. Node and Bun `fetch` have no such store —
 * nothing remembers the session cookie between calls, so every admin request
 * after `login()` would 401. This wrapper is that missing store for
 * non-browser callers (scripts, the publishing CLI).
 *
 * It is deliberately inert when handed to a browser's `fetch`, so wiring it
 * in unconditionally (as `OtaClient` does) is safe even though
 * `@ota/api-sdk` is also consumed by the dashboard:
 *
 * - `response.headers.getSetCookie()` returns `[]` in a browser. `Set-Cookie`
 *   is a forbidden response-header name for script access — browsers strip it
 *   from any `Response.headers` a script can read, so the jar never fills.
 * - `Cookie` is a forbidden request-header name. A script cannot set it, so
 *   even an empty replay is silently dropped and the browser's own cookie
 *   handling (via `credentials: 'include'`) is what actually runs.
 */
export function withCookieJar(fetchImpl: typeof fetch): typeof fetch {
  const jar = new Map<string, Map<string, string>>();

  const fetchWithCookieJar = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const origin = originOf(input);
    const cookies = jar.get(origin);
    const cookieHeader =
      cookies && cookies.size > 0
        ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
        : null;

    // Rebuild the headers only when there is a cookie to inject. Passing a
    // freshly built `Headers` unconditionally would clobber the headers of a
    // `Request` handed in as `input` with no `init` of its own — `fetch` lets
    // `init.headers` win outright rather than merging the two.
    let response: Response;
    if (cookieHeader === null) {
      response = await fetchImpl(input, init);
    } else {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set('cookie', cookieHeader);
      response = await fetchImpl(input, { ...init, headers });
    }

    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const store = jar.get(origin) ?? new Map<string, string>();
      for (const setCookie of setCookies) {
        const pair = setCookie.split(';', 1)[0];
        const separator = pair?.indexOf('=') ?? -1;
        if (!pair || separator === -1) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (name) store.set(name, value);
      }
      jar.set(origin, store);
    }

    return response;
  };

  // Cast at the boundary: Bun's ambient `fetch` type carries a static
  // `preconnect` method that a plain wrapper function has no reason to
  // implement, and callers only ever invoke the returned value, never touch
  // `.preconnect` on it.
  return fetchWithCookieJar as typeof fetch;
}

/** Derives the origin key from any of the three shapes `fetch` accepts as `input`. */
function originOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).origin;
  if (input instanceof URL) return input.origin;
  return new URL(input.url).origin;
}
