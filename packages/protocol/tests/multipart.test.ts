import { describe, expect, test } from 'bun:test';
import { noUpdateAvailableDirective, serializeDirective } from '../src/directives.ts';
import {
  buildMultipartBody,
  extractPartBody,
  generateBoundary,
  parseBoundary,
} from '../src/multipart.ts';
import { buildDirectiveResponse, buildUpdateResponse } from '../src/response.ts';
import { createSigner, verifySignature } from '../src/signature.ts';
import { TEST_CERT_PEM, TEST_KEY_ID, TEST_KEY_PEM } from './helpers.ts';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildMultipartBody', () => {
  test('emits the exact byte layout the client expects', () => {
    const body = decode(
      buildMultipartBody(
        [
          {
            name: 'manifest',
            body: '{"id":"x"}',
            headers: { 'expo-signature': 'sig="abc", keyid="main"' },
          },
        ],
        'BOUNDARY',
      ),
    );

    expect(body).toBe(
      '--BOUNDARY\r\n' +
        'content-disposition: form-data; name="manifest"\r\n' +
        'content-type: application/json\r\n' +
        'expo-signature: sig="abc", keyid="main"\r\n' +
        '\r\n' +
        '{"id":"x"}\r\n' +
        '--BOUNDARY--\r\n',
    );
  });

  test('has no preamble and terminates with a closing boundary', () => {
    const body = decode(buildMultipartBody([{ name: 'directive', body: '{}' }], 'B'));
    expect(body.startsWith('--B\r\n')).toBe(true);
    expect(body.endsWith('--B--\r\n')).toBe(true);
  });

  test('writes multiple parts in order', () => {
    const body = decode(
      buildMultipartBody(
        [
          { name: 'manifest', body: '{"a":1}' },
          { name: 'extensions', body: '{"assetRequestHeaders":{}}' },
        ],
        'B',
      ),
    );
    expect(body.indexOf('name="manifest"')).toBeLessThan(body.indexOf('name="extensions"'));
  });

  test('boundaries are hex-only so they cannot collide with base64 bodies', () => {
    const boundary = generateBoundary();
    expect(boundary).toMatch(/^oat[0-9a-f]{32}$/);
  });
});

describe('extractPartBody', () => {
  test('round-trips every part', () => {
    const manifest = '{"id":"abc","assets":[]}';
    const extensions = '{"assetRequestHeaders":{"k":{"h":"v"}}}';
    const body = buildMultipartBody(
      [
        { name: 'manifest', body: manifest },
        { name: 'extensions', body: extensions },
      ],
      'B',
    );

    expect(extractPartBody(body, 'B', 'manifest')).toBe(manifest);
    expect(extractPartBody(body, 'B', 'extensions')).toBe(extensions);
    expect(extractPartBody(body, 'B', 'directive')).toBe(null);
  });

  test('preserves bodies containing CRLF', () => {
    const tricky = 'line1\r\nline2\r\n';
    const body = buildMultipartBody([{ name: 'manifest', body: tricky }], 'B');
    expect(extractPartBody(body, 'B', 'manifest')).toBe(tricky);
  });
});

describe('parseBoundary', () => {
  test.each([
    ['multipart/mixed; boundary=abc123', 'abc123'],
    ['multipart/mixed; boundary="abc123"', 'abc123'],
    ['multipart/mixed; charset=utf-8; boundary=abc123', 'abc123'],
    ['application/json', null],
  ])('%s', (input, expected) => {
    expect(parseBoundary(input)).toBe(expected);
  });
});

/**
 * The test that matters most.
 *
 * "Signed one string, emitted another" is invisible in unit tests of the signer
 * alone — it only surfaces when a device rejects the update. Building the real
 * response, pulling the manifest part back off the wire and verifying it
 * against the certificate is what proves the whole path is byte-consistent.
 */
describe('signature survives the multipart round trip', () => {
  test('manifest part verifies after extraction', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const manifestJson = JSON.stringify({
      id: '0000aaaa-bbbb-4ccc-8ddd-eeeeffff0000',
      createdAt: '2026-08-10T12:00:00.000Z',
      runtimeVersion: '1.5.0',
      launchAsset: { hash: 'h', key: 'k', contentType: 'application/javascript', url: 'u' },
      assets: [],
      metadata: {},
      extra: { expoClient: { name: 'fixture' } },
    });

    const response = buildUpdateResponse({
      manifestJson,
      signatureHeader: await signer.signHeader(manifestJson),
    });

    const boundary = parseBoundary(response.headers['content-type'] ?? '');
    expect(boundary).not.toBe(null);

    const extracted = extractPartBody(response.body, boundary!, 'manifest');
    expect(extracted).toBe(manifestJson);

    const wire = decode(response.body);
    const signature = /expo-signature: sig="([^"]+)"/.exec(wire)?.[1];
    expect(signature).toBeDefined();
    expect(await verifySignature(extracted!, signature!, TEST_CERT_PEM)).toBe(true);
  });

  test('directive part verifies after extraction', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const response = await buildDirectiveResponse(noUpdateAvailableDirective(), signer);

    const boundary = parseBoundary(response.headers['content-type'] ?? '')!;
    const extracted = extractPartBody(response.body, boundary, 'directive');
    expect(extracted).toBe(serializeDirective(noUpdateAvailableDirective()));

    const signature = /expo-signature: sig="([^"]+)"/.exec(decode(response.body))?.[1];
    expect(await verifySignature(extracted!, signature!, TEST_CERT_PEM)).toBe(true);
  });
});
