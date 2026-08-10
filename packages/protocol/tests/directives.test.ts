import { describe, expect, test } from 'bun:test';
import {
  noUpdateAvailableDirective,
  rollBackToEmbeddedDirective,
  serializeDirective,
} from '../src/directives.ts';
import { ProtocolError } from '../src/errors.ts';
import { extractPartBody, parseBoundary } from '../src/multipart.ts';
import {
  buildDirectiveResponse,
  buildErrorResponse,
  buildUpdateResponse,
} from '../src/response.ts';
import { createSigner, verifySignature } from '../src/signature.ts';
import { TEST_CERT_PEM, TEST_KEY_ID, TEST_KEY_PEM } from './helpers.ts';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('directives', () => {
  test('noUpdateAvailable is exactly {"type":"noUpdateAvailable"}', () => {
    const directive = noUpdateAvailableDirective();
    expect(serializeDirective(directive)).toBe('{"type":"noUpdateAvailable"}');
    // No `parameters` key at all — not an empty object.
    expect('parameters' in directive).toBe(false);
  });

  test('rollBackToEmbedded carries an ISO 8601 commitTime', () => {
    const directive = rollBackToEmbeddedDirective(new Date('2026-08-10T12:00:00.000Z'));
    expect(serializeDirective(directive)).toBe(
      '{"type":"rollBackToEmbedded","parameters":{"commitTime":"2026-08-10T12:00:00.000Z"}}',
    );
  });
});

describe('response headers', () => {
  test('an update response sets the required protocol headers', () => {
    const response = buildUpdateResponse({ manifestJson: '{"id":"x"}' });
    expect(response.status).toBe(200);
    expect(response.headers['expo-protocol-version']).toBe('1');
    expect(response.headers['expo-sfv-version']).toBe('0');
    expect(response.headers['cache-control']).toBe('private, max-age=0');
    expect(response.headers['content-type']).toStartWith('multipart/mixed; boundary=');
  });

  test('the extensions part is omitted when there are no asset request headers', () => {
    const response = buildUpdateResponse({ manifestJson: '{"id":"x"}' });
    expect(decode(response.body)).not.toContain('name="extensions"');
  });

  test('the extensions part is included when asset request headers exist', () => {
    const response = buildUpdateResponse({
      manifestJson: '{"id":"x"}',
      assetRequestHeaders: { abc: { authorization: 'Bearer t' } },
    });
    const boundary = parseBoundary(response.headers['content-type']!)!;
    expect(extractPartBody(response.body, boundary, 'extensions')).toBe(
      '{"assetRequestHeaders":{"abc":{"authorization":"Bearer t"}}}',
    );
  });

  test('no expo-signature part header when unsigned', () => {
    const response = buildUpdateResponse({ manifestJson: '{"id":"x"}', signatureHeader: null });
    expect(decode(response.body)).not.toContain('expo-signature');
  });
});

describe('directive responses', () => {
  test('are unsigned when no signer is supplied', async () => {
    const response = await buildDirectiveResponse(noUpdateAvailableDirective(), null);
    expect(decode(response.body)).not.toContain('expo-signature');
  });

  test('are signed when a signer is supplied', async () => {
    // The client throws "No expo-signature header specified" if it asked for a
    // signature and a directive arrives without one — the most common
    // self-hosted failure.
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const response = await buildDirectiveResponse(noUpdateAvailableDirective(), signer);

    const wire = decode(response.body);
    expect(wire).toContain('expo-signature: sig=');
    expect(wire).toContain('keyid="main"');

    const boundary = parseBoundary(response.headers['content-type']!)!;
    const body = extractPartBody(response.body, boundary, 'directive')!;
    const signature = /expo-signature: sig="([^"]+)"/.exec(wire)![1]!;
    expect(await verifySignature(body, signature, TEST_CERT_PEM)).toBe(true);
  });

  test('a rollback directive signs its own body, not the manifest', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const commitTime = new Date('2026-08-10T12:00:00.000Z');
    const response = await buildDirectiveResponse(rollBackToEmbeddedDirective(commitTime), signer);

    const boundary = parseBoundary(response.headers['content-type']!)!;
    const body = extractPartBody(response.body, boundary, 'directive')!;
    expect(JSON.parse(body).parameters.commitTime).toBe(commitTime.toISOString());

    const signature = /expo-signature: sig="([^"]+)"/.exec(decode(response.body))![1]!;
    expect(await verifySignature(body, signature, TEST_CERT_PEM)).toBe(true);
  });
});

describe('error responses', () => {
  test('emit JSON when the client sent expo-json-error', () => {
    const response = buildErrorResponse(
      new ProtocolError('INVALID_PLATFORM', 400, 'bad platform'),
      true,
    );
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(decode(response.body))).toEqual({
      error: 'INVALID_PLATFORM',
      message: 'bad platform',
    });
  });

  test('fall back to plain text otherwise', () => {
    const response = buildErrorResponse(
      new ProtocolError('MISSING_RUNTIME_VERSION', 400, 'no runtime'),
      false,
    );
    expect(response.headers['content-type']).toStartWith('text/plain');
    expect(decode(response.body)).toBe('MISSING_RUNTIME_VERSION: no runtime');
  });
});
