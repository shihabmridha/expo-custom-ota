import { describe, expect, test } from 'bun:test';
import { withCookieJar } from '../src/cookie-jar.ts';

/** Builds a stub `fetch` that returns a canned response and records what it was called with. */
function stubFetch(setCookies: string[] = []): {
  fetch: typeof fetch;
  calls: (RequestInit | undefined)[];
} {
  const calls: (RequestInit | undefined)[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init);
    const headers = new Headers();
    for (const setCookie of setCookies) headers.append('set-cookie', setCookie);
    return new Response(null, { headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function cookieHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('cookie');
}

describe('withCookieJar', () => {
  test('replays a stored cookie to the same origin', async () => {
    const { fetch: inner, calls } = stubFetch(['session=abc123; Path=/; HttpOnly']);
    const wrapped = withCookieJar(inner);

    await wrapped('https://ota.example.com/api/auth/login');
    await wrapped('https://ota.example.com/api/releases');

    expect(cookieHeader(calls[0])).toBeNull();
    expect(cookieHeader(calls[1])).toBe('session=abc123');
  });

  test('does not replay a cookie to a different origin', async () => {
    const { fetch: inner, calls } = stubFetch(['session=abc123']);
    const wrapped = withCookieJar(inner);

    await wrapped('https://ota.example.com/api/auth/login');
    await wrapped('https://other.example.com/api/releases');

    expect(cookieHeader(calls[1])).toBeNull();
  });

  test('merges the Cookie header without dropping an existing content-type', async () => {
    const { fetch: inner, calls } = stubFetch(['session=abc123']);
    const wrapped = withCookieJar(inner);

    await wrapped('https://ota.example.com/api/auth/login');
    await wrapped('https://ota.example.com/api/releases', {
      headers: { 'content-type': 'application/json' },
    });

    const headers = new Headers(calls[1]?.headers);
    expect(headers.get('cookie')).toBe('session=abc123');
    expect(headers.get('content-type')).toBe('application/json');
  });

  test('stores every cookie from a response with multiple Set-Cookie entries', async () => {
    const { fetch: inner, calls } = stubFetch(['a=1; Path=/', 'b=2; Path=/']);
    const wrapped = withCookieJar(inner);

    await wrapped('https://ota.example.com/api/auth/login');
    await wrapped('https://ota.example.com/api/releases');

    const cookie = cookieHeader(calls[1]);
    expect(cookie).toContain('a=1');
    expect(cookie).toContain('b=2');
  });

  test('a response with no Set-Cookie does not clear the jar', async () => {
    const calls: (RequestInit | undefined)[] = [];
    // First call sets a cookie; every later call returns none, but the header it
    // *received* is recorded so we can check the cookie was still replayed.
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) {
        const headers = new Headers();
        headers.append('set-cookie', 'session=abc123');
        return new Response(null, { headers });
      }
      return new Response(null);
    }) as typeof globalThis.fetch;
    const wrapped = withCookieJar(fetch);

    await wrapped('https://ota.example.com/api/auth/login'); // stores session=abc123
    await wrapped('https://ota.example.com/api/no-op'); // returns no Set-Cookie
    await wrapped('https://ota.example.com/api/releases'); // should still replay the cookie

    expect(cookieHeader(calls[1])).toBe('session=abc123');
    expect(cookieHeader(calls[2])).toBe('session=abc123');
  });
});
