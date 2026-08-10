import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import { buildManifest, serializeManifest } from '@oat/protocol';
import type { DeploymentAction, Platform } from '@oat/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from '../lib/logger.ts';
import type { SigningService } from './signing.ts';

/**
 * Publishing, promotion and rollback.
 *
 * Every deployment write is an upsert against
 * `UNIQUE(application_id, channel_id, platform, runtime_version)`. There is no
 * read-modify-write anywhere, so two administrators publishing different
 * releases to the same target concurrently always leave exactly one row — the
 * last writer wins deterministically, and both attempts are recorded in
 * `deployment_events`.
 */

export class PublishError extends Error {
  override readonly name = 'PublishError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PublishDeps {
  db: OatDatabase;
  logger: Logger;
  signing?: SigningService;
}

export interface DeploymentResult {
  channelName: string;
  platform: Platform;
  runtimeVersion: string;
  updateId: string;
}

interface VariantRow {
  id: string;
  platform: Platform;
  runtimeVersion: string;
  updateId: string;
}

async function loadPublishableRelease(db: OatDatabase, releaseId: string) {
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId))
    .limit(1);

  const release = rows[0];
  if (!release) throw new PublishError('RELEASE_NOT_FOUND', 'Unknown release.');

  // An incomplete import must never be publishable.
  if (release.importStatus !== 'ready') {
    throw new PublishError(
      'RELEASE_NOT_READY',
      `Release #${release.releaseNumber} is not ready to publish (import status: ${release.importStatus}).`,
    );
  }
  return release;
}

/**
 * Resolve a channel *within the owning application*.
 *
 * Looking it up by name alone would allow publishing one application's release
 * into another's channel — the isolation invariant is enforced here.
 */
async function resolveChannel(db: OatDatabase, applicationId: string, name: string) {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.applicationId, applicationId), eq(schema.channels.name, name)))
    .limit(1);

  const channel = rows[0];
  if (!channel) {
    throw new PublishError('CHANNEL_NOT_FOUND', `This application has no channel named "${name}".`);
  }
  return channel;
}

async function loadVariants(
  db: OatDatabase,
  releaseId: string,
  platforms?: Platform[],
): Promise<VariantRow[]> {
  const rows = await db
    .select({
      id: schema.releaseVariants.id,
      platform: schema.releaseVariants.platform,
      runtimeVersion: schema.releaseVariants.runtimeVersion,
      updateId: schema.releaseVariants.updateId,
    })
    .from(schema.releaseVariants)
    .where(eq(schema.releaseVariants.releaseId, releaseId));

  const filtered = platforms ? rows.filter((r) => platforms.includes(r.platform)) : rows;
  if (filtered.length === 0) {
    throw new PublishError(
      'NO_VARIANTS',
      platforms
        ? `This release has no variant for ${platforms.join(', ')}.`
        : 'This release has no platform variants.',
    );
  }
  return filtered;
}

/** Upsert one deployment and record the change. */
async function deploy(
  db: OatDatabase,
  args: {
    applicationId: string;
    channelId: string;
    channelName: string;
    variant: VariantRow;
    action: DeploymentAction;
    actorAdminId?: string | undefined;
  },
): Promise<DeploymentResult> {
  const existing = await db
    .select({ variantId: schema.deployments.releaseVariantId })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.applicationId, args.applicationId),
        eq(schema.deployments.channelId, args.channelId),
        eq(schema.deployments.platform, args.variant.platform),
        eq(schema.deployments.runtimeVersion, args.variant.runtimeVersion),
      ),
    )
    .limit(1);

  await db
    .insert(schema.deployments)
    .values({
      id: crypto.randomUUID(),
      applicationId: args.applicationId,
      channelId: args.channelId,
      platform: args.variant.platform,
      runtimeVersion: args.variant.runtimeVersion,
      releaseVariantId: args.variant.id,
      directive: null,
      directiveCommitTime: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.deployments.applicationId,
        schema.deployments.channelId,
        schema.deployments.platform,
        schema.deployments.runtimeVersion,
      ],
      set: {
        releaseVariantId: args.variant.id,
        directive: null,
        directiveCommitTime: null,
        version: sql`${schema.deployments.version} + 1`,
        updatedAt: new Date(),
      },
    });

  await db.insert(schema.deploymentEvents).values({
    id: crypto.randomUUID(),
    applicationId: args.applicationId,
    channelId: args.channelId,
    platform: args.variant.platform,
    runtimeVersion: args.variant.runtimeVersion,
    fromVariantId: existing[0]?.variantId ?? null,
    toVariantId: args.variant.id,
    action: args.action,
    actorAdminId: args.actorAdminId ?? null,
  });

  return {
    channelName: args.channelName,
    platform: args.variant.platform,
    runtimeVersion: args.variant.runtimeVersion,
    updateId: args.variant.updateId,
  };
}

export async function publishRelease(
  deps: PublishDeps,
  input: {
    releaseId: string;
    channel: string;
    platforms?: Platform[] | undefined;
    actorAdminId?: string | undefined;
  },
) {
  const { db, logger } = deps;
  const release = await loadPublishableRelease(db, input.releaseId);
  const channel = await resolveChannel(db, release.applicationId, input.channel);
  const variants = await loadVariants(db, release.id, input.platforms);

  const deployments: DeploymentResult[] = [];
  for (const variant of variants) {
    deployments.push(
      await deploy(db, {
        applicationId: release.applicationId,
        channelId: channel.id,
        channelName: channel.name,
        variant,
        action: 'publish',
        actorAdminId: input.actorAdminId,
      }),
    );
  }

  if (release.status === 'draft') {
    await db
      .update(schema.releases)
      .set({ status: 'published' })
      .where(eq(schema.releases.id, release.id));
  }

  logger.info('release_published', {
    applicationId: release.applicationId,
    releaseId: release.id,
    releaseNumber: release.releaseNumber,
    channel: channel.name,
    platforms: variants.map((v) => v.platform),
  });

  return { releaseId: release.id, releaseNumber: release.releaseNumber, deployments };
}

/**
 * Promotion re-points the target channel at the **same** release variants.
 *
 * Nothing is rebuilt, re-signed or re-uploaded, which is what guarantees that
 * what reaches production is byte-identical to what was tested in staging.
 */
export async function promoteRelease(
  deps: PublishDeps,
  input: {
    releaseId: string;
    fromChannel: string;
    toChannel: string;
    platforms?: Platform[] | undefined;
    actorAdminId?: string | undefined;
  },
) {
  const { db, logger } = deps;
  const release = await loadPublishableRelease(db, input.releaseId);
  const from = await resolveChannel(db, release.applicationId, input.fromChannel);
  const to = await resolveChannel(db, release.applicationId, input.toChannel);

  if (from.id === to.id) {
    throw new PublishError('SAME_CHANNEL', 'Source and target channels are the same.');
  }

  const variants = await loadVariants(db, release.id, input.platforms);

  // Only promote what is actually live on the source channel — promoting
  // something never deployed to staging would defeat the purpose.
  const live = await db
    .select({ variantId: schema.deployments.releaseVariantId })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.applicationId, release.applicationId),
        eq(schema.deployments.channelId, from.id),
        inArray(
          schema.deployments.releaseVariantId,
          variants.map((v) => v.id),
        ),
      ),
    );
  const liveIds = new Set(live.map((d) => d.variantId));
  const promotable = variants.filter((v) => liveIds.has(v.id));

  if (promotable.length === 0) {
    throw new PublishError(
      'NOT_DEPLOYED',
      `Release #${release.releaseNumber} is not currently deployed to "${from.name}", so there is ` +
        'nothing to promote. Publish it there first.',
    );
  }

  const deployments: DeploymentResult[] = [];
  for (const variant of promotable) {
    deployments.push(
      await deploy(db, {
        applicationId: release.applicationId,
        channelId: to.id,
        channelName: to.name,
        variant,
        action: 'promote',
        actorAdminId: input.actorAdminId,
      }),
    );
  }

  logger.info('release_promoted', {
    applicationId: release.applicationId,
    releaseId: release.id,
    from: from.name,
    to: to.name,
  });

  return { releaseId: release.id, releaseNumber: release.releaseNumber, deployments };
}

/**
 * Rollback creates a NEW release from an old one's contents.
 *
 * Clients are never pointed backwards at an old update id: the new release gets
 * a fresh `updateId`, `createdAt`, manifest and signature, while referencing
 * the same immutable asset rows. Nothing is re-uploaded.
 */
export async function createRollbackRelease(
  deps: PublishDeps,
  input: {
    sourceReleaseId: string;
    channel: string;
    platforms?: Platform[] | undefined;
    message?: string | undefined;
    actorAdminId?: string | undefined;
  },
) {
  const { db, logger, signing } = deps;
  const source = await loadPublishableRelease(db, input.sourceReleaseId);
  const channel = await resolveChannel(db, source.applicationId, input.channel);
  const sourceVariants = await loadVariants(db, source.id, input.platforms);

  const newReleaseId = crypto.randomUUID();
  const now = Date.now();

  await db.run(sql`
    INSERT INTO releases
      (id, application_id, release_number, message, status, import_status,
       rollback_of_release_id, created_by, created_at, updated_at)
    SELECT
      ${newReleaseId},
      ${source.applicationId},
      COALESCE(MAX(release_number), 0) + 1,
      ${input.message ?? `Rollback to release #${source.releaseNumber}`},
      'published',
      'ready',
      ${source.id},
      ${input.actorAdminId ?? null},
      ${now},
      ${now}
    FROM releases WHERE application_id = ${source.applicationId}
  `);

  const created = await db
    .select({ releaseNumber: schema.releases.releaseNumber })
    .from(schema.releases)
    .where(eq(schema.releases.id, newReleaseId))
    .limit(1);
  const releaseNumber = created[0]!.releaseNumber;

  const signer = signing ? await signing.getSigner(source.applicationId) : null;
  const createdAt = new Date();
  const newVariants: VariantRow[] = [];

  for (const sourceVariant of sourceVariants) {
    const full = await db
      .select()
      .from(schema.releaseVariants)
      .where(eq(schema.releaseVariants.id, sourceVariant.id))
      .limit(1);
    const original = full[0]!;

    // Rebuild the manifest from the stored one, changing only identity. The
    // asset list — and therefore every hash and URL — is carried over
    // untouched, so the bytes devices download are literally the same objects.
    const previous = JSON.parse(original.manifest) as ReturnType<typeof buildManifest>;
    const updateId = crypto.randomUUID();
    const manifestJson = serializeManifest(
      buildManifest({
        updateId,
        createdAt,
        runtimeVersion: original.runtimeVersion,
        launchAsset: {
          hash: previous.launchAsset.hash!,
          key: previous.launchAsset.key,
          url: previous.launchAsset.url,
        },
        assets: previous.assets.map((asset) => ({
          hash: asset.hash!,
          key: asset.key,
          ext: asset.fileExtension?.replace(/^\./, '') ?? null,
          contentType: asset.contentType,
          url: asset.url,
        })),
        expoClientConfig: (original.expoConfig ?? {}) as Record<string, unknown>,
      }),
    );

    const variantId = crypto.randomUUID();
    await db.insert(schema.releaseVariants).values({
      id: variantId,
      releaseId: newReleaseId,
      platform: original.platform,
      runtimeVersion: original.runtimeVersion,
      updateId,
      manifest: manifestJson,
      manifestSignature: signer ? await signer.sign(manifestJson) : null,
      signingKeyId: signer ? signer.keyId : null,
      launchAssetId: original.launchAssetId,
      expoConfig: original.expoConfig,
    });

    // Point at the same immutable asset rows — no storage IO at all.
    const sourceAssets = await db
      .select()
      .from(schema.releaseAssets)
      .where(eq(schema.releaseAssets.releaseVariantId, sourceVariant.id));

    for (const asset of sourceAssets) {
      await db.insert(schema.releaseAssets).values({
        id: crypto.randomUUID(),
        releaseVariantId: variantId,
        assetId: asset.assetId,
        assetKey: asset.assetKey,
        type: asset.type,
        fileExtension: asset.fileExtension,
        sortOrder: asset.sortOrder,
      });
    }

    newVariants.push({
      id: variantId,
      platform: original.platform,
      runtimeVersion: original.runtimeVersion,
      updateId,
    });
  }

  const deployments: DeploymentResult[] = [];
  for (const variant of newVariants) {
    deployments.push(
      await deploy(db, {
        applicationId: source.applicationId,
        channelId: channel.id,
        channelName: channel.name,
        variant,
        action: 'rollback',
        actorAdminId: input.actorAdminId,
      }),
    );
  }

  logger.info('release_rollback_created', {
    applicationId: source.applicationId,
    sourceReleaseId: source.id,
    releaseId: newReleaseId,
    releaseNumber,
    channel: channel.name,
  });

  return { releaseId: newReleaseId, releaseNumber, deployments };
}

/** Deploy the `rollBackToEmbedded` kill-switch to one target. */
export async function setRollBackToEmbedded(
  deps: PublishDeps,
  input: {
    applicationId: string;
    channel: string;
    platform: Platform;
    runtimeVersion: string;
    actorAdminId?: string | undefined;
  },
) {
  const { db, logger } = deps;
  const channel = await resolveChannel(db, input.applicationId, input.channel);

  const existing = await db
    .select({ variantId: schema.deployments.releaseVariantId })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.applicationId, input.applicationId),
        eq(schema.deployments.channelId, channel.id),
        eq(schema.deployments.platform, input.platform),
        eq(schema.deployments.runtimeVersion, input.runtimeVersion),
      ),
    )
    .limit(1);

  await db
    .insert(schema.deployments)
    .values({
      id: crypto.randomUUID(),
      applicationId: input.applicationId,
      channelId: channel.id,
      platform: input.platform,
      runtimeVersion: input.runtimeVersion,
      releaseVariantId: null,
      directive: 'rollBackToEmbedded',
      directiveCommitTime: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.deployments.applicationId,
        schema.deployments.channelId,
        schema.deployments.platform,
        schema.deployments.runtimeVersion,
      ],
      set: {
        releaseVariantId: null,
        directive: 'rollBackToEmbedded',
        directiveCommitTime: new Date(),
        version: sql`${schema.deployments.version} + 1`,
        updatedAt: new Date(),
      },
    });

  await db.insert(schema.deploymentEvents).values({
    id: crypto.randomUUID(),
    applicationId: input.applicationId,
    channelId: channel.id,
    platform: input.platform,
    runtimeVersion: input.runtimeVersion,
    fromVariantId: existing[0]?.variantId ?? null,
    toVariantId: null,
    action: 'rollback_to_embedded',
    actorAdminId: input.actorAdminId ?? null,
  });

  logger.warn('rollback_to_embedded_set', {
    applicationId: input.applicationId,
    channel: channel.name,
    platform: input.platform,
    runtimeVersion: input.runtimeVersion,
  });
}
