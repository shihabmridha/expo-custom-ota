import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';
import type { OtaDatabase } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { certificateInfo } from '@ota/protocol';
import { and, desc, eq, sql } from 'drizzle-orm';

/**
 * Application lifecycle.
 */

export class ApplicationError extends Error {
  override readonly name = 'ApplicationError';
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The public identifier in the OTA URL.
 *
 * Not a secret — it only selects which application a device is talking to — but
 * generated with a CSPRNG anyway so it cannot be guessed and enumerated.
 */
export function generateUpdateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ota_${Buffer.from(bytes).toString('base64url')}`;
}

export async function createApplication(
  db: OtaDatabase,
  input: {
    name: string;
    slug: string;
    description?: string | undefined;
    androidPackage?: string | undefined;
    iosBundleIdentifier?: string | undefined;
    defaultChannel: string;
  },
) {
  const existing = await db
    .select({ id: schema.applications.id })
    .from(schema.applications)
    .where(eq(schema.applications.slug, input.slug))
    .limit(1);
  if (existing[0]) {
    throw new ApplicationError(
      'SLUG_TAKEN',
      409,
      `An application with slug "${input.slug}" already exists.`,
    );
  }

  const id = crypto.randomUUID();
  await db.insert(schema.applications).values({
    id,
    name: input.name,
    slug: input.slug,
    updateKey: generateUpdateKey(),
    description: input.description ?? null,
    androidPackage: input.androidPackage ?? null,
    iosBundleIdentifier: input.iosBundleIdentifier ?? null,
    defaultChannel: input.defaultChannel,
  });

  // production and staging always exist, so the first publish has somewhere to
  // go without an extra setup step.
  const channels = new Set(['production', 'staging', input.defaultChannel]);
  for (const name of channels) {
    await db.insert(schema.channels).values({ id: crypto.randomUUID(), applicationId: id, name });
  }

  const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, id));
  return rows[0]!;
}

/**
 * Generate an RSA-2048 code signing key and self-signed certificate.
 *
 * Uses `@expo/code-signing-certificates` — Expo's own generator — so the
 * certificate carries exactly the extensions the client validates
 * (`keyUsage: digitalSignature` critical, `extKeyUsage: codeSigning` critical).
 *
 * The private key is written to SIGNING_KEYS_DIRECTORY and never stored in the
 * database, never returned by the API, and never reaches the dashboard.
 */
export async function generateSigningKey(
  db: OtaDatabase,
  keysDirectory: string,
  input: {
    applicationId: string;
    applicationSlug: string;
    keyId: string;
    commonName?: string | undefined;
    validityYears: number;
  },
) {
  const keyPair = generateKeyPair();
  const validityNotBefore = new Date();
  const validityNotAfter = new Date();
  validityNotAfter.setFullYear(validityNotAfter.getFullYear() + input.validityYears);

  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore,
    validityNotAfter,
    commonName: input.commonName ?? input.applicationSlug,
  });

  const certificatePem = convertCertificateToCertificatePEM(certificate);
  const { privateKeyPEM } = convertKeyPairToPEM(keyPair);

  await mkdir(keysDirectory, { recursive: true });
  const filename = `${input.applicationSlug}-${input.keyId}.pem`;
  await Bun.write(join(keysDirectory, filename), privateKeyPEM);

  const info = certificateInfo(certificatePem);

  // Retire any previous key first: the partial unique index permits only one
  // active key per application.
  await db
    .update(schema.applicationSigningKeys)
    .set({ status: 'retired' })
    .where(
      and(
        eq(schema.applicationSigningKeys.applicationId, input.applicationId),
        eq(schema.applicationSigningKeys.status, 'active'),
      ),
    );

  await db.insert(schema.applicationSigningKeys).values({
    id: crypto.randomUUID(),
    applicationId: input.applicationId,
    keyId: input.keyId,
    certificatePem,
    certificateFingerprint: info.fingerprintSha256,
    certificateNotAfter: info.notAfter,
    privateKeyRef: filename,
    status: 'active',
  });

  return {
    keyId: input.keyId,
    certificatePem,
    certificateFingerprint: info.fingerprintSha256,
    certificateNotAfter: info.notAfter.toISOString(),
    status: 'active' as const,
    createdAt: new Date().toISOString(),
  };
}

/** Everything the dashboard's list view shows, in one pass. */
export async function listApplicationSummaries(db: OtaDatabase, publicUrl: string) {
  const apps = await db
    .select()
    .from(schema.applications)
    .orderBy(desc(schema.applications.createdAt));

  const summaries = [];
  for (const app of apps) {
    const releaseCount = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, app.id));

    const deployments = await db
      .select({
        channelName: schema.channels.name,
        runtimeVersion: schema.deployments.runtimeVersion,
        releaseNumber: schema.releases.releaseNumber,
      })
      .from(schema.deployments)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.deployments.channelId))
      .leftJoin(
        schema.releaseVariants,
        eq(schema.releaseVariants.id, schema.deployments.releaseVariantId),
      )
      .leftJoin(schema.releases, eq(schema.releases.id, schema.releaseVariants.releaseId))
      .where(eq(schema.deployments.applicationId, app.id));

    const byChannel = new Map<string, number | null>();
    for (const d of deployments) {
      const current = byChannel.get(d.channelName) ?? null;
      if (d.releaseNumber !== null && (current === null || d.releaseNumber > current)) {
        byChannel.set(d.channelName, d.releaseNumber);
      } else if (!byChannel.has(d.channelName)) {
        byChannel.set(d.channelName, current);
      }
    }

    const signingKey = await db
      .select({ id: schema.applicationSigningKeys.id })
      .from(schema.applicationSigningKeys)
      .where(
        and(
          eq(schema.applicationSigningKeys.applicationId, app.id),
          eq(schema.applicationSigningKeys.status, 'active'),
        ),
      )
      .limit(1);

    summaries.push({
      ...serializeApplication(app, publicUrl),
      releaseCount: Number(releaseCount[0]?.n ?? 0),
      channelSummaries: [...byChannel.entries()].map(([channel, latestReleaseNumber]) => ({
        channel,
        latestReleaseNumber,
      })),
      runtimeVersionCount: new Set(deployments.map((d) => d.runtimeVersion)).size,
      hasSigningKey: signingKey.length > 0,
    });
  }

  return summaries;
}

type ApplicationRow = typeof schema.applications.$inferSelect;

export function serializeApplication(app: ApplicationRow, _publicUrl: string) {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    updateKey: app.updateKey,
    description: app.description,
    androidPackage: app.androidPackage,
    iosBundleIdentifier: app.iosBundleIdentifier,
    defaultChannel: app.defaultChannel,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

/** The copy-pasteable `app.json` fragment shown on the client setup screen. */
export function buildClientConfig(
  app: ApplicationRow,
  publicUrl: string,
  signing: { keyId: string; certificatePem: string } | null,
  channels: string[],
) {
  const otaUrl = `${publicUrl}/api/v1/updates/${app.updateKey}`;

  const snippet = {
    expo: {
      updates: {
        url: otaUrl,
        // `expo-channel-name`, not `x-ota-channel` — this is what EAS and every
        // Expo tool use. See docs/decisions.md D6.
        requestHeaders: { 'expo-channel-name': app.defaultChannel },
        ...(signing
          ? {
              codeSigningCertificate: './certs/certificate.pem',
              codeSigningMetadata: { keyid: signing.keyId, alg: 'rsa-v1_5-sha256' },
            }
          : {}),
      },
      runtimeVersion: '1.0.0',
    },
  };

  return {
    otaUrl,
    updateKey: app.updateKey,
    defaultChannel: app.defaultChannel,
    certificatePem: signing?.certificatePem ?? null,
    keyId: signing?.keyId ?? null,
    appJsonSnippet: JSON.stringify(snippet, null, 2),
    channels,
  };
}
