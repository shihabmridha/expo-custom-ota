import { contracts } from '@ota/contracts';
import * as schema from '@ota/db/schema/index';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.ts';
import { ApplicationError } from '../../services/applications.ts';
import { ImportError, importRelease } from '../../services/import/importer.ts';
import {
  createRollbackRelease,
  promoteRelease,
  publishRelease,
  setRollBackToEmbedded,
} from '../../services/publishing.ts';
import { handle } from './validate.ts';

export const releaseRoutes = new Hono<AppEnv>();

type ReleaseRow = typeof schema.releases.$inferSelect;

function serializeRelease(release: ReleaseRow) {
  return {
    id: release.id,
    applicationId: release.applicationId,
    releaseNumber: release.releaseNumber,
    message: release.message,
    status: release.status,
    importStatus: release.importStatus,
    importError: release.importError,
    sourceFilename: release.sourceFilename,
    sourceRevision: release.sourceRevision,
    sourceMetadata: release.sourceMetadata,
    sourceSizeBytes: release.sourceSizeBytes,
    rollbackOfReleaseId: release.rollbackOfReleaseId,
    createdAt: release.createdAt.toISOString(),
  };
}

async function loadRelease(c: { var: AppEnv['Variables'] }, id: string) {
  const rows = await c.var.db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, id))
    .limit(1);
  const release = rows[0];
  if (!release) throw new ApplicationError('NOT_FOUND', 404, 'Unknown release.');
  return release;
}

// --- Listing and detail -----------------------------------------------------

releaseRoutes.get('/applications/:id/releases', async (c) => {
  const rows = await c.var.db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.applicationId, c.req.param('id')!))
    .orderBy(desc(schema.releases.releaseNumber));
  return c.json(rows.map(serializeRelease));
});

releaseRoutes.get('/releases/:releaseId', async (c) => {
  const release = await loadRelease(c, c.req.param('releaseId')!);

  const variants = await c.var.db
    .select()
    .from(schema.releaseVariants)
    .where(eq(schema.releaseVariants.releaseId, release.id));

  const detailed = [];
  for (const variant of variants) {
    const sizes = await c.var.db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${schema.assets.sizeBytes}), 0)`,
      })
      .from(schema.releaseAssets)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.releaseAssets.assetId))
      .where(eq(schema.releaseAssets.releaseVariantId, variant.id));

    const launch = await c.var.db
      .select({ size: schema.assets.sizeBytes })
      .from(schema.assets)
      .where(eq(schema.assets.id, variant.launchAssetId))
      .limit(1);

    detailed.push({
      id: variant.id,
      platform: variant.platform,
      runtimeVersion: variant.runtimeVersion,
      updateId: variant.updateId,
      signed: variant.manifestSignature !== null,
      signingKeyId: variant.signingKeyId,
      // The launch asset is counted separately from the asset total.
      assetCount: Math.max(0, Number(sizes[0]?.count ?? 0) - 1),
      launchAssetSizeBytes: launch[0]?.size ?? 0,
      totalSizeBytes: Number(sizes[0]?.total ?? 0),
      createdAt: variant.createdAt.toISOString(),
    });
  }

  const variantIds = variants.map((v) => v.id);
  const deployed =
    variantIds.length > 0
      ? await c.var.db
          .select({
            channelName: schema.channels.name,
            platform: schema.deployments.platform,
            runtimeVersion: schema.deployments.runtimeVersion,
          })
          .from(schema.deployments)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.deployments.channelId))
          .where(inArray(schema.deployments.releaseVariantId, variantIds))
      : [];

  return c.json({ ...serializeRelease(release), variants: detailed, deployedTo: deployed });
});

releaseRoutes.delete('/releases/:releaseId', async (c) => {
  const release = await loadRelease(c, c.req.param('releaseId')!);

  // Published releases are immutable — archive them instead of deleting.
  if (release.status !== 'draft') {
    throw new ApplicationError(
      'RELEASE_NOT_DRAFT',
      409,
      `Release #${release.releaseNumber} is ${release.status} and cannot be deleted. Published ` +
        'releases are immutable; archive it instead.',
    );
  }

  const variants = await c.var.db
    .select({ id: schema.releaseVariants.id })
    .from(schema.releaseVariants)
    .where(eq(schema.releaseVariants.releaseId, release.id));

  if (variants.length > 0) {
    const live = await c.var.db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(
        inArray(
          schema.deployments.releaseVariantId,
          variants.map((v) => v.id),
        ),
      )
      .limit(1);
    if (live[0]) {
      throw new ApplicationError(
        'RELEASE_DEPLOYED',
        409,
        'This release is currently deployed. Deploy something else first.',
      );
    }
  }

  await c.var.db.delete(schema.releases).where(eq(schema.releases.id, release.id));
  return c.json({ ok: true as const });
});

// --- Import -----------------------------------------------------------------

/**
 * Raw `application/zip` body rather than multipart/form-data: Bun's
 * `req.formData()` buffers the entire body in memory.
 */
releaseRoutes.post(
  '/applications/:id/releases/import',
  handle(contracts.releases.import, async (c, { query }) => {
    const { db, env, storage, logger, signing } = c.var;

    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new ApplicationError('EMPTY_UPLOAD', 400, 'Request body was empty.');
    }
    if (buffer.byteLength > env.MAX_UPLOAD_BYTES) {
      throw new ApplicationError(
        'UPLOAD_TOO_LARGE',
        413,
        `Archive is ${buffer.byteLength} bytes, over the ${env.MAX_UPLOAD_BYTES} byte limit.`,
      );
    }

    logger.info('release_uploaded', {
      applicationId: c.req.param('id'),
      bytes: buffer.byteLength,
      filename: query.filename,
    });

    const result = await importRelease(
      {
        db,
        storage,
        signing,
        logger,
        limits: {
          maxEntries: env.MAX_ARCHIVE_ENTRIES,
          maxTotalUncompressedBytes: env.MAX_EXTRACTED_BYTES,
          maxEntryBytes: env.MAX_UPLOAD_BYTES,
          maxCompressionRatio: env.MAX_COMPRESSION_RATIO,
        },
      },
      {
        applicationId: c.req.param('id')!,
        archive: new Uint8Array(buffer),
        sourceFilename: query.filename,
        message: query.message,
        idempotencyKey: c.req.header('idempotency-key'),
        createdBy: c.var.admin?.id,
      },
    );

    return c.json(result, 201);
  }),
);

// --- Publishing -------------------------------------------------------------

releaseRoutes.post(
  '/releases/:releaseId/publish',
  handle(contracts.releases.publish, async (c, { body: input }) => {
    const result = await publishRelease(
      { db: c.var.db, logger: c.var.logger },
      {
        releaseId: c.req.param('releaseId')!,
        channel: input.channel,
        platforms: input.platforms,
        actorAdminId: c.var.admin?.id,
      },
    );
    return c.json(result);
  }),
);

releaseRoutes.post(
  '/releases/:releaseId/promote',
  handle(contracts.releases.promote, async (c, { body: input }) => {
    const result = await promoteRelease(
      { db: c.var.db, logger: c.var.logger },
      {
        releaseId: c.req.param('releaseId')!,
        fromChannel: input.fromChannel,
        toChannel: input.toChannel,
        platforms: input.platforms,
        actorAdminId: c.var.admin?.id,
      },
    );
    return c.json(result);
  }),
);

releaseRoutes.post(
  '/releases/:releaseId/rollback',
  handle(contracts.releases.rollback, async (c, { body: input }) => {
    const result = await createRollbackRelease(
      {
        db: c.var.db,
        logger: c.var.logger,
        signing: c.var.signing,
      },
      {
        sourceReleaseId: c.req.param('releaseId')!,
        channel: input.channel,
        platforms: input.platforms,
        message: input.message,
        actorAdminId: c.var.admin?.id,
      },
    );
    return c.json(result);
  }),
);

releaseRoutes.post(
  '/applications/:id/deployments/roll-back-to-embedded',
  handle(contracts.deployments.rollBackToEmbedded, async (c, { body: input }) => {
    await setRollBackToEmbedded(
      { db: c.var.db, logger: c.var.logger },
      {
        applicationId: c.req.param('id')!,
        channel: input.channel,
        platform: input.platform,
        runtimeVersion: input.runtimeVersion,
        actorAdminId: c.var.admin?.id,
      },
    );
    return c.json({ ok: true as const });
  }),
);

// --- History and metrics ----------------------------------------------------

releaseRoutes.get('/applications/:id/deployment-events', async (c) => {
  const rows = await c.var.db
    .select({
      id: schema.deploymentEvents.id,
      channelName: schema.channels.name,
      platform: schema.deploymentEvents.platform,
      runtimeVersion: schema.deploymentEvents.runtimeVersion,
      action: schema.deploymentEvents.action,
      fromVariantId: schema.deploymentEvents.fromVariantId,
      toVariantId: schema.deploymentEvents.toVariantId,
      createdAt: schema.deploymentEvents.createdAt,
    })
    .from(schema.deploymentEvents)
    .leftJoin(schema.channels, eq(schema.channels.id, schema.deploymentEvents.channelId))
    .where(eq(schema.deploymentEvents.applicationId, c.req.param('id')!))
    .orderBy(desc(schema.deploymentEvents.createdAt))
    .limit(200);

  const variantIds = rows
    .flatMap((r) => [r.fromVariantId, r.toVariantId])
    .filter(Boolean) as string[];
  const variants =
    variantIds.length > 0
      ? await c.var.db
          .select({ id: schema.releaseVariants.id, updateId: schema.releaseVariants.updateId })
          .from(schema.releaseVariants)
          .where(inArray(schema.releaseVariants.id, variantIds))
      : [];
  const updateIdByVariant = new Map(variants.map((v) => [v.id, v.updateId]));

  return c.json(
    rows.map((r) => ({
      id: r.id,
      channelName: r.channelName ?? '(deleted)',
      platform: r.platform,
      runtimeVersion: r.runtimeVersion,
      action: r.action,
      fromUpdateId: r.fromVariantId ? (updateIdByVariant.get(r.fromVariantId) ?? null) : null,
      toUpdateId: r.toVariantId ? (updateIdByVariant.get(r.toVariantId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

releaseRoutes.get('/applications/:id/metrics', async (c) => {
  const applicationId = c.req.param('id');

  const releaseCount = await c.var.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.releases)
    .where(eq(schema.releases.applicationId, applicationId));

  const assetStats = await c.var.db
    .select({
      n: sql<number>`count(distinct ${schema.assets.id})`,
      bytes: sql<number>`coalesce(sum(distinct ${schema.assets.sizeBytes}), 0)`,
    })
    .from(schema.assets)
    .innerJoin(schema.releaseAssets, eq(schema.releaseAssets.assetId, schema.assets.id))
    .innerJoin(
      schema.releaseVariants,
      eq(schema.releaseVariants.id, schema.releaseAssets.releaseVariantId),
    )
    .innerJoin(schema.releases, eq(schema.releases.id, schema.releaseVariants.releaseId))
    .where(eq(schema.releases.applicationId, applicationId));

  const daily = await c.var.db
    .select({
      day: schema.usageDaily.day,
      platform: schema.usageDaily.platform,
      result: schema.usageDaily.result,
      count: schema.usageDaily.count,
    })
    .from(schema.usageDaily)
    .where(eq(schema.usageDaily.applicationId, applicationId))
    .orderBy(desc(schema.usageDaily.day))
    .limit(200);

  return c.json({
    totals: {
      releases: Number(releaseCount[0]?.n ?? 0),
      assets: Number(assetStats[0]?.n ?? 0),
      storageBytes: Number(assetStats[0]?.bytes ?? 0),
    },
    daily,
  });
});

export { ImportError };
