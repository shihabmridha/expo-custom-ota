#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.ts';
import { createApplication, generateSigningKey } from '../src/services/applications.ts';

/**
 * Prepare an application for device verification.
 *
 * Creates the expo-custom-ota E2E application if it does not exist, ensures it has an
 * active signing key, writes the certificate into the test app, and prints the
 * URL to build with.
 *
 * Idempotent, and safe to re-run against a different server — which is the
 * point: the LAN pass and the VPS pass use the same command.
 *
 *   bun run e2e:setup
 */
const SLUG = 'oat-e2e';
const PACKAGE = 'xyz.acadion.oate2e';

const repoRoot = dirname(dirname(import.meta.dir));
const certPath = join(repoRoot, 'e2e', 'expo-test-app', 'certs', 'certificate.pem');

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL });

const existing = await db
  .select()
  .from(schema.applications)
  .where(eq(schema.applications.slug, SLUG))
  .limit(1);

let application = existing[0];

if (application) {
  console.log(`Reusing existing application "${SLUG}".`);
} else {
  application = await createApplication(db, {
    name: 'expo-custom-ota E2E',
    slug: SLUG,
    androidPackage: PACKAGE,
    iosBundleIdentifier: PACKAGE,
    defaultChannel: 'production',
  });
  console.log(`Created application "${SLUG}".`);
}

// Reuse the existing key: regenerating would invalidate the certificate already
// embedded in any installed build.
const activeKey = await db
  .select()
  .from(schema.applicationSigningKeys)
  .where(eq(schema.applicationSigningKeys.applicationId, application.id))
  .limit(1);

let certificatePem: string;
let keyId: string;

const forceRotate = process.argv.includes('--rotate');

if (activeKey[0] && activeKey[0].status === 'active' && !forceRotate) {
  certificatePem = activeKey[0].certificatePem;
  keyId = activeKey[0].keyId;
  console.log(`Reusing signing key "${keyId}" — regenerating would break installed builds.`);
} else {
  if (forceRotate) {
    console.warn(
      [
        '⚠  Rotating the signing key. Every release already published was signed with the',
        '   old key and will be REFUSED by any installed build, whose embedded certificate',
        '   no longer matches. Those builds need rebuilding.',
      ].join('\n'),
    );
  }
  const generated = await generateSigningKey(db, env.signingKeysDirAbsolute, {
    applicationId: application.id,
    applicationSlug: SLUG,
    keyId: 'main',
    commonName: 'expo-custom-ota E2E',
    validityYears: 10,
  });
  certificatePem = generated.certificatePem;
  keyId = generated.keyId;
  console.log(`Generated signing key "${keyId}".`);
}

mkdirSync(dirname(certPath), { recursive: true });
const certChanged = !existsSync(certPath) || Bun.file(certPath).size === 0;
writeFileSync(certPath, certificatePem);

const updateUrl = `${env.OTA_PUBLIC_URL}/api/v1/updates/${application.updateKey}`;

console.log(
  `\nCertificate written to e2e/expo-test-app/certs/certificate.pem${certChanged ? '' : ' (refreshed)'}`,
);
console.log('\nBuild the test app with:\n');
console.log(`  OTA_UPDATE_URL=${updateUrl} \\`);
console.log('    bunx expo run:android --variant release\n');

if (env.OTA_PUBLIC_URL.includes('localhost') || env.OTA_PUBLIC_URL.includes('127.0.0.1')) {
  console.warn(
    '⚠  OTA_PUBLIC_URL points at localhost, which a device or emulator cannot reach.\n' +
      '   Set it to a LAN IP or a real domain before building — it is baked into signed\n' +
      '   manifests, so changing it later means republishing every release.\n',
  );
}
