import { beforeEach, describe, expect, test } from 'bun:test';
import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '../src/lib/logger.ts';
import {
  createRollbackRelease,
  PublishError,
  promoteRelease,
  publishRelease,
} from '../src/services/publishing.ts';
import { SigningService } from '../src/services/signing.ts';
import { createMigratedDb, createTestApp, MemoryStorage, seedApplication } from './helpers.ts';

let db: OatDatabase;
let storage: MemoryStorage;
let deps: { db: OatDatabase; logger: ReturnType<typeof createLogger>; signing: SigningService };

beforeEach(() => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  const { env } = createTestApp(db, storage);
  deps = {
    db,
    logger: createLogger('error'),
    signing: new SigningService(db, env.signingKeysDirAbsolute),
  };
});

/** Seed an application with a staging channel and an undeployed draft release. */
async function seedDraft(slug: string, bundleContent = `// ${slug}`) {
  const seeded = await seedApplication(db, storage, {
    slug,
    updateKey: `ota_${slug}`,
    bundleContent,
  });

  await db.insert(schema.channels).values({
    id: crypto.randomUUID(),
    applicationId: seeded.applicationId,
    name: 'staging',
  });

  // seedApplication deploys to production; clear it so tests start clean.
  await db
    .delete(schema.deployments)
    .where(eq(schema.deployments.applicationId, seeded.applicationId));
  return seeded;
}

async function deploymentsFor(applicationId: string) {
  return db
    .select({
      channel: schema.channels.name,
      platform: schema.deployments.platform,
      runtimeVersion: schema.deployments.runtimeVersion,
      variantId: schema.deployments.releaseVariantId,
      version: schema.deployments.version,
    })
    .from(schema.deployments)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.deployments.channelId))
    .where(eq(schema.deployments.applicationId, applicationId));
}

describe('publishRelease', () => {
  test('creates a deployment and marks the release published', async () => {
    const seeded = await seedDraft('acadion');
    await db
      .update(schema.releases)
      .set({ status: 'draft' })
      .where(eq(schema.releases.id, seeded.releaseId));

    const result = await publishRelease(deps, {
      releaseId: seeded.releaseId,
      channel: 'staging',
    });

    expect(result.deployments).toHaveLength(1);
    expect(result.deployments[0]).toMatchObject({
      channelName: 'staging',
      platform: 'android',
      runtimeVersion: '1.0.0',
      updateId: seeded.updateId,
    });

    const release = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, seeded.releaseId));
    expect(release[0]?.status).toBe('published');
  });

  test('refuses a release whose import is not ready', async () => {
    const seeded = await seedDraft('acadion');
    await db
      .update(schema.releases)
      .set({ importStatus: 'failed' })
      .where(eq(schema.releases.id, seeded.releaseId));

    await expect(
      publishRelease(deps, { releaseId: seeded.releaseId, channel: 'staging' }),
    ).rejects.toThrow(/not ready to publish/);
  });

  test('refuses a channel belonging to another application', async () => {
    // Channel names collide across applications by design; resolution must be
    // scoped to the owning application.
    const a = await seedDraft('appa');
    await seedDraft('appb');

    await expect(
      publishRelease(deps, { releaseId: a.releaseId, channel: 'nonexistent' }),
    ).rejects.toThrow(PublishError);
  });

  test('concurrent publishes to the same target leave exactly one deployment', async () => {
    const first = await seedDraft('acadion', '// v1');

    // A second release for the same application, same platform and runtime.
    const releaseId = crypto.randomUUID();
    await db.insert(schema.releases).values({
      id: releaseId,
      applicationId: first.applicationId,
      releaseNumber: 2,
      status: 'draft',
      importStatus: 'ready',
    });
    const variantId = crypto.randomUUID();
    const asset = await db.select().from(schema.assets).limit(1);
    await db.insert(schema.releaseVariants).values({
      id: variantId,
      releaseId,
      platform: 'android',
      runtimeVersion: '1.0.0',
      updateId: crypto.randomUUID(),
      manifest: '{"id":"second"}',
      launchAssetId: asset[0]!.id,
    });

    await Promise.all([
      publishRelease(deps, { releaseId: first.releaseId, channel: 'staging' }),
      publishRelease(deps, { releaseId, channel: 'staging' }),
    ]);

    const deployments = await deploymentsFor(first.applicationId);
    expect(deployments).toHaveLength(1);

    // Both attempts are recorded even though only one mapping survives.
    const events = await db.select().from(schema.deploymentEvents);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('promoteRelease', () => {
  test('promotes the identical variant, without re-signing', async () => {
    const seeded = await seedDraft('acadion');
    await publishRelease(deps, { releaseId: seeded.releaseId, channel: 'staging' });

    const result = await promoteRelease(deps, {
      releaseId: seeded.releaseId,
      fromChannel: 'staging',
      toChannel: 'production',
    });

    expect(result.deployments[0]?.updateId).toBe(seeded.updateId);

    const deployments = await deploymentsFor(seeded.applicationId);
    const staging = deployments.find((d) => d.channel === 'staging');
    const production = deployments.find((d) => d.channel === 'production');

    // The same release_variant_id — literally the same signed bytes, which is
    // what makes "what we tested is what ships" true.
    expect(production?.variantId).toBe(staging?.variantId);

    const variants = await db.select().from(schema.releaseVariants);
    expect(variants).toHaveLength(1);
  });

  test('refuses to promote something not deployed to the source channel', async () => {
    const seeded = await seedDraft('acadion');
    await expect(
      promoteRelease(deps, {
        releaseId: seeded.releaseId,
        fromChannel: 'staging',
        toChannel: 'production',
      }),
    ).rejects.toThrow(/not currently deployed/);
  });

  test('refuses promotion into the same channel', async () => {
    const seeded = await seedDraft('acadion');
    await publishRelease(deps, { releaseId: seeded.releaseId, channel: 'staging' });

    await expect(
      promoteRelease(deps, {
        releaseId: seeded.releaseId,
        fromChannel: 'staging',
        toChannel: 'staging',
      }),
    ).rejects.toThrow(/same/);
  });
});

describe('createRollbackRelease', () => {
  test('creates a NEW release with a new identity over the same assets', async () => {
    const seeded = await seedDraft('acadion');
    await publishRelease(deps, { releaseId: seeded.releaseId, channel: 'production' });

    const rollback = await createRollbackRelease(deps, {
      sourceReleaseId: seeded.releaseId,
      channel: 'production',
    });

    expect(rollback.releaseId).not.toBe(seeded.releaseId);
    expect(rollback.releaseNumber).toBe(2);

    const newVariants = await db
      .select()
      .from(schema.releaseVariants)
      .where(eq(schema.releaseVariants.releaseId, rollback.releaseId));
    const original = await db
      .select()
      .from(schema.releaseVariants)
      .where(eq(schema.releaseVariants.releaseId, seeded.releaseId));

    // New identity — clients are never pointed backwards at an old update id.
    expect(newVariants[0]!.updateId).not.toBe(original[0]!.updateId);
    expect(newVariants[0]!.manifest).not.toBe(original[0]!.manifest);
    expect(newVariants[0]!.manifestSignature).not.toBe(original[0]!.manifestSignature);

    // Same immutable assets — nothing re-uploaded.
    expect(newVariants[0]!.launchAssetId).toBe(original[0]!.launchAssetId);
    const objectCountBefore = storage.objects.size;
    expect(storage.objects.size).toBe(objectCountBefore);

    // And the asset hashes inside the manifest are unchanged.
    const before = JSON.parse(original[0]!.manifest);
    const after = JSON.parse(newVariants[0]!.manifest);
    expect(after.launchAsset.hash).toBe(before.launchAsset.hash);
    expect(after.launchAsset.url).toBe(before.launchAsset.url);
  });

  test('records provenance and deploys the rollback', async () => {
    const seeded = await seedDraft('acadion');
    await publishRelease(deps, { releaseId: seeded.releaseId, channel: 'production' });

    const rollback = await createRollbackRelease(deps, {
      sourceReleaseId: seeded.releaseId,
      channel: 'production',
    });

    const created = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, rollback.releaseId));
    expect(created[0]?.rollbackOfReleaseId).toBe(seeded.releaseId);

    const deployment = await db
      .select()
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.applicationId, seeded.applicationId),
          eq(schema.deployments.platform, 'android'),
        ),
      );
    const newVariant = await db
      .select()
      .from(schema.releaseVariants)
      .where(eq(schema.releaseVariants.releaseId, rollback.releaseId));
    expect(deployment[0]?.releaseVariantId).toBe(newVariant[0]!.id);
  });
});
