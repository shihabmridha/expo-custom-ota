import { describe, expect, test } from 'bun:test';
import { serializeSignatureHeader } from '../src/sfv.ts';
import {
  certificateInfo,
  createSigner,
  validateCodeSigningCertificate,
  verifySignature,
} from '../src/signature.ts';
import { OTHER_CERT_PEM, TEST_CERT_PEM, TEST_KEY_ID, TEST_KEY_PEM } from './helpers.ts';

const PAYLOAD = JSON.stringify({ id: 'abc', runtimeVersion: '1.5.0' });

describe('signing', () => {
  test('a correct signature verifies against its certificate', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const signature = await signer.sign(PAYLOAD);
    expect(await verifySignature(PAYLOAD, signature, TEST_CERT_PEM)).toBe(true);
  });

  test('a mutated payload fails verification', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const signature = await signer.sign(PAYLOAD);

    // A single character changed anywhere in the manifest must break it.
    const mutated = PAYLOAD.replace('1.5.0', '1.5.1');
    expect(mutated).not.toBe(PAYLOAD);
    expect(await verifySignature(mutated, signature, TEST_CERT_PEM)).toBe(false);
  });

  test('whitespace-only reserialization fails verification', async () => {
    // This is the failure mode the sign-once discipline exists to prevent: the
    // JSON is semantically identical but the bytes differ.
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const signature = await signer.sign(PAYLOAD);
    const reserialized = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
    expect(await verifySignature(reserialized, signature, TEST_CERT_PEM)).toBe(false);
  });

  test('the wrong certificate fails verification', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const signature = await signer.sign(PAYLOAD);
    expect(await verifySignature(PAYLOAD, signature, OTHER_CERT_PEM)).toBe(false);
  });

  test('signatures are standard base64 with padding, not base64url', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const signature = await signer.sign(PAYLOAD);

    // A 2048-bit RSA signature is 256 bytes -> 344 base64 chars ending in '='.
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(signature).not.toMatch(/[-_]/);
    expect(Buffer.from(signature, 'base64').byteLength).toBe(256);
  });

  test('signHeader emits the exact reference-server format', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const header = await signer.signHeader(PAYLOAD);
    expect(header).toMatch(/^sig="[A-Za-z0-9+/=]+", keyid="main"$/);
    // `alg` is deliberately omitted: it is optional and a mismatch only logs.
    expect(header).not.toContain('alg=');
  });

  test('serializeSignatureHeader escapes quotes and backslashes', () => {
    expect(serializeSignatureHeader('abc==', 'we"ird\\key')).toBe(
      'sig="abc==", keyid="we\\"ird\\\\key"',
    );
  });
});

describe('certificateInfo', () => {
  test('reads the test certificate', () => {
    const info = certificateInfo(TEST_CERT_PEM);
    expect(info.subject).toContain('OAT Test Signing');
    expect(info.isSelfSigned).toBe(true);
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(info.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});

describe('validateCodeSigningCertificate', () => {
  test('accepts a valid RSA-2048 code-signing certificate', () => {
    expect(validateCodeSigningCertificate(TEST_CERT_PEM)).toEqual([]);
  });

  test('rejects garbage', () => {
    const problems = validateCodeSigningCertificate('not a certificate');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain('Not a valid X.509 certificate');
  });

  test('reports an expired certificate', () => {
    const farFuture = new Date('2099-01-01T00:00:00Z');
    const problems = validateCodeSigningCertificate(TEST_CERT_PEM, farFuture);
    expect(problems.some((p) => p.includes('expired'))).toBe(true);
  });
});
