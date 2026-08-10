import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSigner } from '../src/signature.ts';
import { findOpenssl, TEST_CERT_PEM, TEST_KEY_ID, TEST_KEY_PEM } from './helpers.ts';

/**
 * Interop with OpenSSL.
 *
 * Everything else in this suite verifies our signatures with our own verifier,
 * which would happily agree with itself if both sides were wrong the same way.
 * OpenSSL is an independent implementation of the same primitives the iOS and
 * Android clients use (SecKey / JCA), so agreement here is real evidence that a
 * device will accept what we produce.
 */
const openssl = findOpenssl();

if (!openssl) {
  console.warn(
    '\n⚠  openssl not found — skipping protocol interop tests.\n' +
      '   On Windows it ships with Git at C:\\Program Files\\Git\\usr\\bin\\openssl.exe\n' +
      '   but is not on the PowerShell PATH. Set OPENSSL_BIN to run these.\n',
  );
}

const scratch = mkdtempSync(join(tmpdir(), 'oat-openssl-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([openssl!, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe.skipIf(!openssl)('openssl interop', () => {
  test('openssl verifies a signature we produced', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);

    // A realistic manifest, not a toy string.
    const payload = JSON.stringify({
      id: '0192f0c1-9c8e-7a3b-b4d2-1a2b3c4d5e6f',
      createdAt: '2026-08-10T12:00:00.000Z',
      runtimeVersion: '1.0.0',
      launchAsset: {
        hash: 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
        key: '5d41402abc4b2a76b9719d911017c592',
        contentType: 'application/javascript',
        fileExtension: '.bundle',
        url: 'https://ota.example.com/api/v1/assets/sha256/2c/2cf24d',
      },
      assets: [],
      metadata: {},
      extra: { expoClient: { name: 'fixture', slug: 'fixture' } },
    });

    const payloadPath = join(scratch, 'payload.json');
    const sigPath = join(scratch, 'sig.bin');
    const certPath = join(scratch, 'cert.pem');
    const pubPath = join(scratch, 'pub.pem');

    // Write the payload as raw bytes — no trailing newline, or the digest differs.
    await Bun.write(payloadPath, payload);
    await Bun.write(sigPath, Buffer.from(await signer.sign(payload), 'base64'));
    await Bun.write(certPath, TEST_CERT_PEM);

    const pub = await run(['x509', '-pubkey', '-noout', '-in', certPath]);
    expect(pub.code).toBe(0);
    await Bun.write(pubPath, pub.stdout);

    const verify = await run([
      'dgst',
      '-sha256',
      '-verify',
      pubPath,
      '-signature',
      sigPath,
      payloadPath,
    ]);

    expect(verify.stdout.trim()).toBe('Verified OK');
    expect(verify.code).toBe(0);
  });

  test('openssl rejects a signature over tampered content', async () => {
    const signer = await createSigner(TEST_KEY_PEM, TEST_KEY_ID);
    const payload = '{"runtimeVersion":"1.0.0"}';

    const payloadPath = join(scratch, 'tampered.json');
    const sigPath = join(scratch, 'tampered.bin');
    const pubPath = join(scratch, 'pub.pem');

    await Bun.write(sigPath, Buffer.from(await signer.sign(payload), 'base64'));
    await Bun.write(payloadPath, '{"runtimeVersion":"9.9.9"}');

    const verify = await run([
      'dgst',
      '-sha256',
      '-verify',
      pubPath,
      '-signature',
      sigPath,
      payloadPath,
    ]);
    expect(verify.stdout.trim()).not.toBe('Verified OK');
    expect(verify.code).not.toBe(0);
  });

  test('the test certificate carries the extensions Expo requires', async () => {
    const certPath = join(scratch, 'cert.pem');
    await Bun.write(certPath, TEST_CERT_PEM);

    const { code, stdout } = await run(['x509', '-noout', '-text', '-in', certPath]);
    expect(code).toBe(0);

    // These four properties are what `expo/code-signing-certificates` sets and
    // what the client's certificate validation expects.
    expect(stdout).toContain('Signature Algorithm: sha256WithRSAEncryption');
    expect(stdout).toMatch(/X509v3 Key Usage: critical\s+Digital Signature/);
    expect(stdout).toMatch(/X509v3 Extended Key Usage: critical\s+Code Signing/);
    expect(stdout).toContain('CA:FALSE');
    expect(stdout).toMatch(/Public-Key: \(2048 bit\)/);
  });
});
