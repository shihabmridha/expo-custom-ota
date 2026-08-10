import { describe, expect, test } from 'bun:test';
import { parseExpoUpdateRequest } from '../src/request.ts';

/**
 * The header set a real `expo-updates` client sends. Taken from
 * `FileDownloader.kt` / `FileDownloader.swift` — note `multipart/mixed` comes
 * first and there are no q-params, which is the opposite of the spec's example.
 */
function realClientHeaders(overrides: Record<string, string | null> = {}): Headers {
  const base: Record<string, string> = {
    accept: 'multipart/mixed,application/expo+json,application/json',
    'expo-platform': 'android',
    'expo-protocol-version': '1',
    'expo-api-version': '1',
    'expo-updates-environment': 'BARE',
    'expo-json-error': 'true',
    'eas-client-id': '8b3f9c1e-0000-4000-8000-000000000000',
    'expo-runtime-version': '1.5.0',
    'expo-channel-name': 'production',
  };
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return headers;
}

function parse(headers: Headers, method = 'GET') {
  return parseExpoUpdateRequest(method, headers);
}

describe('parseExpoUpdateRequest', () => {
  test('parses a real client request', () => {
    const result = parse(realClientHeaders());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      protocolVersion: 1,
      apiVersion: 1,
      platform: 'android',
      runtimeVersion: '1.5.0',
      channelName: 'production',
      acceptsMultipart: true,
      jsonError: true,
      expectSignature: null,
    });
  });

  test('rejects non-GET with 405', () => {
    const result = parse(realClientHeaders(), 'POST');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(405);
    expect(result.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('absent protocol version means version 0', () => {
    const result = parse(realClientHeaders({ 'expo-protocol-version': null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protocolVersion).toBe(0);
  });

  test('rejects an unsupported protocol version', () => {
    const result = parse(realClientHeaders({ 'expo-protocol-version': '2' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(400);
    expect(result.error.code).toBe('INVALID_PROTOCOL_VERSION');
  });

  test.each([
    ['missing', null],
    ['windows', 'windows'],
    ['web', 'web'],
    ['empty', ''],
  ])('rejects platform: %s', (_label, value) => {
    const result = parse(realClientHeaders({ 'expo-platform': value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(400);
    expect(result.error.code).toBe('INVALID_PLATFORM');
  });

  test('accepts uppercase platform', () => {
    const result = parse(realClientHeaders({ 'expo-platform': 'IOS' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform).toBe('ios');
  });

  test('rejects a missing runtime version', () => {
    const result = parse(realClientHeaders({ 'expo-runtime-version': null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(400);
    expect(result.error.code).toBe('MISSING_RUNTIME_VERSION');
  });

  test('rejects an unsupported Accept with 406', () => {
    const result = parse(realClientHeaders({ accept: 'text/html' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(406);
    expect(result.error.code).toBe('NOT_ACCEPTABLE');
  });

  test('a JSON-only client does not accept multipart', () => {
    const result = parse(realClientHeaders({ accept: 'application/json' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptsMultipart).toBe(false);
  });

  test('honours q-params and wildcards in Accept', () => {
    const spec = parse(
      realClientHeaders({
        accept: 'application/expo+json;q=0.9, application/json;q=0.8, multipart/mixed',
      }),
    );
    expect(spec.ok && spec.value.acceptsMultipart).toBe(true);

    const wildcard = parse(realClientHeaders({ accept: '*/*' }));
    expect(wildcard.ok && wildcard.value.acceptsMultipart).toBe(true);
  });

  test('normalises update ids to lowercase', () => {
    const result = parse(
      realClientHeaders({
        'expo-current-update-id': '0000AAAA-BBBB-4CCC-8DDD-EEEEFFFF0000',
        'expo-embedded-update-id': '1111AAAA-BBBB-4CCC-8DDD-EEEEFFFF1111',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentUpdateId).toBe('0000aaaa-bbbb-4ccc-8ddd-eeeeffff0000');
    expect(result.value.embeddedUpdateId).toBe('1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111');
  });

  test('falls back to the legacy channel header', () => {
    const result = parse(
      realClientHeaders({ 'expo-channel-name': null, 'x-ota-channel': 'staging' }),
    );
    expect(result.ok && result.value.channelName).toBe('staging');
  });

  test('prefers expo-channel-name over the legacy header', () => {
    const result = parse(
      realClientHeaders({ 'expo-channel-name': 'production', 'x-ota-channel': 'staging' }),
    );
    expect(result.ok && result.value.channelName).toBe('production');
  });

  test('channel is null when no channel header is present', () => {
    const result = parse(realClientHeaders({ 'expo-channel-name': null }));
    expect(result.ok && result.value.channelName).toBe(null);
  });

  describe('expo-expect-signature', () => {
    test('parses the full dictionary', () => {
      const result = parse(
        realClientHeaders({
          'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.expectSignature).toEqual({ keyid: 'main', alg: 'rsa-v1_5-sha256' });
    });

    test('defaults keyid to "root" when omitted, matching the native client', () => {
      const result = parse(realClientHeaders({ 'expo-expect-signature': 'sig' }));
      expect(result.ok && result.value.expectSignature).toEqual({ keyid: 'root', alg: null });
    });

    test('treats a dictionary without sig as no signature requested', () => {
      const result = parse(realClientHeaders({ 'expo-expect-signature': 'keyid="main"' }));
      expect(result.ok && result.value.expectSignature).toBe(null);
    });

    test('degrades on a malformed header rather than erroring', () => {
      const result = parse(realClientHeaders({ 'expo-expect-signature': '((((not sfv' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.expectSignature).toBe(null);
    });
  });

  test('parses expo-recent-failed-update-ids as an SFV list', () => {
    const result = parse(
      realClientHeaders({
        'expo-recent-failed-update-ids':
          '"0000aaaa-bbbb-4ccc-8ddd-eeeeffff0000", "1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111"',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recentFailedUpdateIds).toEqual([
      '0000aaaa-bbbb-4ccc-8ddd-eeeeffff0000',
      '1111aaaa-bbbb-4ccc-8ddd-eeeeffff1111',
    ]);
  });

  test('parses expo-extra-params as an SFV string dictionary', () => {
    const result = parse(
      realClientHeaders({ 'expo-extra-params': 'branch="feature-x", tester="qa"' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraParams).toEqual({ branch: 'feature-x', tester: 'qa' });
  });

  test('captures expo-fatal-error', () => {
    const result = parse(realClientHeaders({ 'expo-fatal-error': 'TypeError: undefined' }));
    expect(result.ok && result.value.fatalError).toBe('TypeError: undefined');
  });
});
