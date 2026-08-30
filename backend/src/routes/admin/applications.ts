import { contracts } from '@ota/contracts';
import * as schema from '@ota/db/schema/index';
import {
  buildDirectiveResponse,
  buildUpdateResponse,
  extractPartBody,
  noUpdateAvailableDirective,
  parseBoundary,
  rollBackToEmbeddedDirective,
  verifySignature,
} from '@ota/protocol';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.ts';
import {
  ApplicationError,
  buildClientConfig,
  createApplication,
  generateSigningKey,
  listApplicationSummaries,
  serializeApplication,
} from '../../services/applications.ts';
import { selectUpdate } from '../../services/selection.ts';
import { SigningService } from '../../services/signing.ts';
import { handle } from './validate.ts';

export const applicationRoutes = new Hono<AppEnv>();

async function loadApplication(c: { var: AppEnv['Variables'] }, id: string | undefined) {
  if (!id) throw new ApplicationError('NOT_FOUND', 404, 'Unknown application.');

  const rows = await c.var.db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.id, id))
    .limit(1);

  const app = rows[0];
  if (app) return app;

  // An update key in the id slot is the predictable mistake: it is the value in the
  // updates URL, so it is the one users have to hand.
  const byKey = await c.var.db
    .select({ id: schema.applications.id })
    .from(schema.applications)
    .where(eq(schema.applications.updateKey, id))
    .limit(1);

  if (byKey[0]) {
    throw new ApplicationError(
      'NOT_FOUND',
      404,
      `"${id}" is an update key, not an application id — that is the value in the updates URL. Use ${byKey[0].id}.`,
    );
  }

  throw new ApplicationError('NOT_FOUND', 404, 'Unknown application.');
}

applicationRoutes.get('/', async (c) =>
  c.json(await listApplicationSummaries(c.var.db, c.var.env.OTA_PUBLIC_URL)),
);

applicationRoutes.post(
  '/',
  handle(contracts.applications.create, async (c, { body }) => {
    const app = await createApplication(c.var.db, body);

    // Generated on creation by default, because an application with no signing
    // key silently publishes unsigned updates that a code-signing client will
    // refuse — a failure that only shows up on a device.
    if (body.generateSigningKey) {
      await generateSigningKey(c.var.db, c.var.env.signingKeysDirAbsolute, {
        applicationId: app.id,
        applicationSlug: app.slug,
        keyId: 'main',
        commonName: app.name,
        validityYears: 10,
      });
    }

    c.var.logger.info('application_created', { applicationId: app.id, slug: app.slug });
    return c.json(serializeApplication(app, c.var.env.OTA_PUBLIC_URL), 201);
  }),
);

applicationRoutes.get('/:id', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));
  const all = await listApplicationSummaries(c.var.db, c.var.env.OTA_PUBLIC_URL);
  const summary = all.find((a) => a.id === app.id);
  if (!summary) throw new ApplicationError('NOT_FOUND', 404, 'Unknown application.');
  return c.json(summary);
});

applicationRoutes.patch(
  '/:id',
  handle(contracts.applications.update, async (c, { body }) => {
    const app = await loadApplication(c, c.req.param('id'));

    await c.var.db
      .update(schema.applications)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.applications.id, app.id));

    const updated = await loadApplication(c, app.id);
    c.var.logger.info('application_updated', { applicationId: app.id });
    return c.json(serializeApplication(updated, c.var.env.OTA_PUBLIC_URL));
  }),
);

applicationRoutes.delete('/:id', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));
  await c.var.db.delete(schema.applications).where(eq(schema.applications.id, app.id));
  c.var.logger.warn('application_deleted', { applicationId: app.id, slug: app.slug });
  return c.json({ ok: true as const });
});

applicationRoutes.get('/:id/client-config', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));
  const key = await c.var.signing.getActiveKey(app.id);

  const channels = await c.var.db
    .select({ name: schema.channels.name })
    .from(schema.channels)
    .where(eq(schema.channels.applicationId, app.id));

  return c.json(
    buildClientConfig(
      app,
      c.var.env.OTA_PUBLIC_URL,
      key ? { keyId: key.keyId, certificatePem: key.certificatePem } : null,
      channels.map((ch) => ch.name),
    ),
  );
});

// --- Channels ---------------------------------------------------------------

applicationRoutes.get('/:id/channels', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));
  const rows = await c.var.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.applicationId, app.id));

  return c.json(
    rows.map((ch) => ({
      id: ch.id,
      applicationId: ch.applicationId,
      name: ch.name,
      createdAt: ch.createdAt.toISOString(),
    })),
  );
});

applicationRoutes.post(
  '/:id/channels',
  handle(contracts.channels.create, async (c, { body }) => {
    const app = await loadApplication(c, c.req.param('id'));

    const existing = await c.var.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.applicationId, app.id), eq(schema.channels.name, body.name)))
      .limit(1);
    if (existing[0]) {
      throw new ApplicationError('CHANNEL_EXISTS', 409, `Channel "${body.name}" already exists.`);
    }

    const id = crypto.randomUUID();
    await c.var.db.insert(schema.channels).values({ id, applicationId: app.id, name: body.name });
    return c.json(
      { id, applicationId: app.id, name: body.name, createdAt: new Date().toISOString() },
      201,
    );
  }),
);

// --- Deployments ------------------------------------------------------------

applicationRoutes.get('/:id/deployments', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));

  const rows = await c.var.db
    .select({
      id: schema.deployments.id,
      channelId: schema.deployments.channelId,
      channelName: schema.channels.name,
      platform: schema.deployments.platform,
      runtimeVersion: schema.deployments.runtimeVersion,
      releaseVariantId: schema.deployments.releaseVariantId,
      directive: schema.deployments.directive,
      updatedAt: schema.deployments.updatedAt,
      releaseId: schema.releases.id,
      releaseNumber: schema.releases.releaseNumber,
      updateId: schema.releaseVariants.updateId,
    })
    .from(schema.deployments)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.deployments.channelId))
    .leftJoin(
      schema.releaseVariants,
      eq(schema.releaseVariants.id, schema.deployments.releaseVariantId),
    )
    .leftJoin(schema.releases, eq(schema.releases.id, schema.releaseVariants.releaseId))
    .where(eq(schema.deployments.applicationId, app.id));

  return c.json(rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })));
});

// --- Signing ----------------------------------------------------------------

applicationRoutes.get('/:id/signing', async (c) => {
  const app = await loadApplication(c, c.req.param('id'));
  const rows = await c.var.db
    .select()
    .from(schema.applicationSigningKeys)
    .where(eq(schema.applicationSigningKeys.applicationId, app.id));

  return c.json({
    keys: rows.map((k) => ({
      keyId: k.keyId,
      certificatePem: k.certificatePem,
      certificateFingerprint: k.certificateFingerprint,
      certificateNotAfter: k.certificateNotAfter.toISOString(),
      status: k.status,
      createdAt: k.createdAt.toISOString(),
      // privateKeyRef is deliberately absent: key material — and even its
      // location on disk — never reaches the dashboard.
    })),
  });
});

applicationRoutes.post(
  '/:id/signing/generate',
  handle(contracts.signing.generate, async (c, { body }) => {
    const app = await loadApplication(c, c.req.param('id'));

    const key = await generateSigningKey(c.var.db, c.var.env.signingKeysDirAbsolute, {
      applicationId: app.id,
      applicationSlug: app.slug,
      keyId: body.keyId,
      commonName: body.commonName ?? app.name,
      validityYears: body.validityYears,
    });

    // The signer cache is keyed by application, not by key id, so the retired
    // signer would keep being served until the process restarted.
    c.var.signing.invalidate(app.id);

    // Anything already published was signed with the now-retired key and will
    // be rejected by clients configured for the new certificate.
    c.var.logger.warn('signing_failure', {
      applicationId: app.id,
      reason: 'signing key rotated; previously published releases must be republished',
      keyId: body.keyId,
    });

    return c.json(key, 201);
  }),
);

// --- Simulator --------------------------------------------------------------

/**
 * Replay an update request server-side.
 *
 * Diagnoses "my device isn't updating" without the device: it reports the
 * selection decision, the response parts, and — crucially — whether the stored
 * signature still verifies against the stored certificate.
 */
applicationRoutes.post(
  '/:id/simulate-update-request',
  handle(contracts.applications.simulate, async (c, { body }) => {
    const app = await loadApplication(c, c.req.param('id'));
    const notes: string[] = [];

    const { signing } = c.var;
    const key = await signing.getActiveKey(app.id);
    const signer = body.expectSignature ? await signing.getSigner(app.id) : null;

    if (body.expectSignature && !key) {
      notes.push(
        'This application has no active signing key, so a client configured for code signing ' +
          'would be refused.',
      );
    }

    const channelName = body.channelName ?? app.defaultChannel;
    const decision = await selectUpdate(c.var.db, {
      applicationId: app.id,
      channelName,
      platform: body.platform,
      runtimeVersion: body.runtimeVersion,
      currentUpdateId: body.currentUpdateId?.toLowerCase() ?? null,
      embeddedUpdateId: body.embeddedUpdateId?.toLowerCase() ?? null,
    });

    const response =
      decision.kind === 'update'
        ? buildUpdateResponse({
            manifestJson: decision.manifestJson,
            signatureHeader:
              signer && decision.manifestSignature && decision.keyId
                ? SigningService.headerFor(decision.manifestSignature, decision.keyId)
                : null,
          })
        : decision.kind === 'rollBackToEmbedded'
          ? await buildDirectiveResponse(rollBackToEmbeddedDirective(decision.commitTime), signer)
          : await buildDirectiveResponse(noUpdateAvailableDirective(), signer);

    if (decision.kind === 'noUpdate') {
      const explanations: Record<string, string> = {
        no_deployment: `Nothing is deployed to "${channelName}" for ${body.platform} runtime ${body.runtimeVersion}.`,
        no_channel: `This application has no channel named "${channelName}".`,
        already_current: 'The device already has the deployed update.',
        already_embedded: 'The device is already running its embedded bundle.',
        rollback_unavailable:
          'A rollback is deployed, but the request carried no expo-embedded-update-id.',
      };
      const explanation = explanations[decision.reason];
      if (explanation) notes.push(explanation);
    }

    const wire = new TextDecoder().decode(response.body);
    const boundary = parseBoundary(response.headers['content-type'] ?? '');
    const manifest = boundary ? extractPartBody(response.body, boundary, 'manifest') : null;
    const directive = boundary ? extractPartBody(response.body, boundary, 'directive') : null;
    const signature = /expo-signature: sig="([^"]+)"/.exec(wire)?.[1] ?? null;

    let signatureVerified: boolean | null = null;
    const signedBody = manifest ?? directive;
    if (signature && key && signedBody) {
      signatureVerified = await verifySignature(signedBody, signature, key.certificatePem);
      if (!signatureVerified) {
        notes.push(
          'The signature did NOT verify against the stored certificate. This usually means the ' +
            'signing key was rotated after this release was published — republish it.',
        );
      }
    }

    return c.json({
      status: response.status,
      headers: response.headers,
      decision: decision.kind,
      manifest,
      directive,
      signature,
      signatureVerified,
      notes,
    });
  }),
);
