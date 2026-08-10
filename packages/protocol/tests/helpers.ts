import { join } from 'node:path';

export const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
export const SIGNING_DIR = join(FIXTURES_DIR, 'signing');

export const TEST_KEY_PEM = await Bun.file(join(SIGNING_DIR, 'test-key.pem')).text();
export const TEST_CERT_PEM = await Bun.file(join(SIGNING_DIR, 'test-cert.pem')).text();
export const OTHER_CERT_PEM = await Bun.file(join(SIGNING_DIR, 'other-cert.pem')).text();

/** Self-signed RSA with no keyUsage/extKeyUsage — what `keytool` produces. */
export const ANDROID_APP_SIGNING_CERT_PEM = await Bun.file(
  join(SIGNING_DIR, 'android-app-signing-cert.pem'),
).text();

/** EC key: unusable, since expo-updates only implements rsa-v1_5-sha256. */
export const EC_CERT_PEM = await Bun.file(join(SIGNING_DIR, 'ec-cert.pem')).text();

export const TEST_KEY_ID = 'main';

/**
 * Locate openssl.
 *
 * On Windows it ships with Git but is not on the PowerShell PATH, so tests that
 * need it resolve it explicitly and skip loudly rather than failing when it is
 * genuinely unavailable (e.g. a minimal CI image).
 */
export function findOpenssl(): string | null {
  const fromEnv = Bun.env.OPENSSL_BIN;
  if (fromEnv && Bun.which(fromEnv)) return fromEnv;

  const onPath = Bun.which('openssl');
  if (onPath) return onPath;

  for (const candidate of [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    '/usr/bin/openssl',
  ]) {
    if (Bun.which(candidate)) return candidate;
  }
  return null;
}
