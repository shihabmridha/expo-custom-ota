import { applications } from '@ota/db';
import {
  buildDirectiveResponse,
  buildErrorResponse,
  buildUpdateResponse,
  noUpdateAvailableDirective,
  ProtocolError,
  type ProtocolHttpResponse,
  parseExpoUpdateRequest,
  rollBackToEmbeddedDirective,
} from '@ota/protocol';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.ts';
import { recordDeviceUpdate } from '../services/device-tracking.ts';
import { selectUpdate } from '../services/selection.ts';
import { SigningService } from '../services/signing.ts';
import { recordUpdateRequest } from '../services/usage.ts';

/**
 * The public Expo Updates endpoint.
 *
 * This is the only surface devices talk to. It resolves an application from the
 * URL's update key, parses protocol headers, asks the selection service what to
 * serve, and formats the answer — no protocol knowledge lives here beyond
 * wiring.
 */
export const updatesRoutes = new Hono<AppEnv>();

function toResponse(result: ProtocolHttpResponse): Response {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

updatesRoutes.all('/:updateKey', async (c) => {
  const { db, env, logger, signing } = c.var;

  const parsed = parseExpoUpdateRequest(c.req.method, c.req.raw.headers);
  if (!parsed.ok) {
    // `expo-json-error` may not have been parsed yet, so read it directly.
    const wantsJson = c.req.header('expo-json-error') === 'true';
    logger.warn('request_failed', {
      code: parsed.error.code,
      status: parsed.error.status,
      message: parsed.error.message,
    });
    return toResponse(buildErrorResponse(parsed.error, wantsJson));
  }

  const request = parsed.value;

  const applicationRows = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      defaultChannel: applications.defaultChannel,
    })
    .from(applications)
    .where(eq(applications.updateKey, c.req.param('updateKey')))
    .limit(1);

  const application = applicationRows[0];
  if (!application) {
    return toResponse(
      buildErrorResponse(
        new ProtocolError('UNKNOWN_UPDATE_KEY', 404, 'Unknown update key.'),
        request.jsonError,
      ),
    );
  }

  // Channel comes from `expo-channel-name` (or the legacy header); falling back
  // to the application default means a client that forgot to configure
  // requestHeaders still gets production rather than nothing.
  const channelName = request.channelName ?? application.defaultChannel;

  const requestLog = {
    applicationId: application.id,
    application: application.slug,
    channel: channelName,
    platform: request.platform,
    runtimeVersion: request.runtimeVersion,
    currentUpdateId: request.currentUpdateId,
    // A random per-install UUID minted by the client library, not PII. Logged
    // so a device run can confirm the header actually arrives — the whole of
    // `device_installs` keys on it. Never log `userId`: that one is
    // app-supplied and may be anything at all.
    easClientId: request.easClientId,
  };
  logger.debug('update_requested', requestLog);
  // The usual cause is a camelCase key, which silently drops the app's
  // install-id / user-id / device facts. The header value is not logged: it is
  // app-supplied and may carry the user id.
  if (request.extraParamsUnparsable) logger.debug('extra_params_unparsable', requestLog);

  // Awaited rather than fire-and-forget: `bun:sqlite` is synchronous
  // underneath, so voiding the promise buys no real latency, and awaiting is
  // what keeps the integration tests deterministic.
  const trackDevice = (servedUpdateId: string | null) =>
    recordDeviceUpdate(db, logger, env.DEVICE_TRACKING_ENABLED, {
      applicationId: application.id,
      request,
      channelName,
      servedUpdateId,
    });

  const decision = await selectUpdate(db, {
    applicationId: application.id,
    channelName,
    platform: request.platform,
    runtimeVersion: request.runtimeVersion,
    currentUpdateId: request.currentUpdateId,
    embeddedUpdateId: request.embeddedUpdateId,
  });

  // Directives require protocol v1 and a multipart response. A v0 client that
  // has no update available gets a 404, since it cannot represent "no update".
  const canSendDirective = request.protocolVersion === 1 && request.acceptsMultipart;

  // Only sign when the client asked; signing a directive it did not request is
  // harmless, but skipping it when it did request breaks the client outright.
  const signer = request.expectSignature ? await signing.getSigner(application.id) : null;

  if (request.expectSignature && !signer) {
    logger.error('signing_failure', {
      ...requestLog,
      reason: 'client requested a signature but the application has no active signing key',
    });
    return toResponse(
      buildErrorResponse(
        new ProtocolError(
          'SIGNING_UNAVAILABLE',
          500,
          'This application has no active code signing key, but the client requested a signed response.',
        ),
        request.jsonError,
      ),
    );
  }

  switch (decision.kind) {
    case 'update': {
      // Only attach a signature when the client asked for one, matching the
      // spec and the reference server. The signature itself was computed at
      // import time over the exact stored manifest bytes.
      const signatureHeader =
        request.expectSignature && decision.manifestSignature && decision.keyId
          ? SigningService.headerFor(decision.manifestSignature, decision.keyId)
          : null;

      // The most common self-hosted misconfiguration: the client's
      // `codeSigningMetadata.keyid` does not match the key we signed with, and
      // the client rejects the update with an opaque error. Surface it here.
      if (
        request.expectSignature &&
        decision.keyId &&
        request.expectSignature.keyid !== decision.keyId
      ) {
        logger.warn('signing_failure', {
          ...requestLog,
          reason: 'client keyid does not match the signing key; the client will reject this update',
          clientKeyId: request.expectSignature.keyid,
          serverKeyId: decision.keyId,
        });
      }

      logger.info('update_served', { ...requestLog, servedUpdateId: decision.updateId });
      await recordUpdateRequest(db, application.id, request.platform, 'update_served');
      await trackDevice(decision.updateId);

      return toResponse(
        buildUpdateResponse({
          // Byte-for-byte what was signed at import time.
          manifestJson: decision.manifestJson,
          signatureHeader,
        }),
      );
    }

    case 'rollBackToEmbedded': {
      if (!canSendDirective) {
        return toResponse(
          buildErrorResponse(
            new ProtocolError(
              'DIRECTIVE_NOT_SUPPORTED',
              404,
              'A rollback is deployed, but directives require protocol version 1 and multipart/mixed.',
            ),
            request.jsonError,
          ),
        );
      }

      logger.info('roll_back_to_embedded_served', requestLog);
      await recordUpdateRequest(db, application.id, request.platform, 'roll_back_to_embedded');
      await trackDevice(null);

      return toResponse(
        await buildDirectiveResponse(rollBackToEmbeddedDirective(decision.commitTime), signer),
      );
    }

    default: {
      logger.info('no_update_available', { ...requestLog, reason: decision.reason });
      await recordUpdateRequest(db, application.id, request.platform, 'no_update_available');
      await trackDevice(null);

      if (!canSendDirective) {
        return toResponse(
          buildErrorResponse(
            new ProtocolError(
              'DIRECTIVE_NOT_SUPPORTED',
              404,
              'No update available. Protocol version 0 cannot express this as a directive.',
            ),
            request.jsonError,
          ),
        );
      }

      // 200 with a directive — never a 404 for "nothing new".
      return toResponse(await buildDirectiveResponse(noUpdateAvailableDirective(), signer));
    }
  }
});
