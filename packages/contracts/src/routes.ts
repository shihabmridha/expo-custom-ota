import { z } from 'zod';
import { route } from './define.ts';
import {
  applicationSchema,
  applicationSummarySchema,
  channelSchema,
  clientConfigSchema,
  createApplicationInputSchema,
  createChannelInputSchema,
  deploymentSchema,
  signingKeySchema,
  simulateRequestInputSchema,
  simulateRequestResultSchema,
  updateApplicationInputSchema,
} from './schemas/application.ts';
import { okResponseSchema } from './schemas/common.ts';
import {
  deploymentEventSchema,
  importReleaseQuerySchema,
  importReleaseResultSchema,
  metricsSchema,
  promoteInputSchema,
  publishInputSchema,
  publishResultSchema,
  releaseDetailSchema,
  releaseSchema,
  rollbackInputSchema,
  rollbackToEmbeddedInputSchema,
} from './schemas/release.ts';

/**
 * The complete admin API.
 *
 * Both the backend and the client are generated from this object, so adding an
 * endpoint here gives the client a typed method with no client-side edit, and
 * removing a field breaks compilation on both sides.
 */
export const contracts = {
  auth: {
    login: route({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: z.object({
        email: z.string().email(),
        password: z.string().min(1),
      }),
      response: z.object({
        admin: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
      }),
      auth: 'public',
      summary: 'Exchange credentials for a session cookie',
    }),
    logout: route({
      method: 'POST',
      path: '/api/admin/auth/logout',
      response: okResponseSchema,
      // Public and idempotent on purpose: a client holding an expired or
      // already-destroyed session must still be able to clear its cookie.
      // Requiring a valid session to log out would strand it.
      auth: 'public',
    }),
    session: route({
      method: 'GET',
      path: '/api/admin/auth/session',
      response: z.object({
        admin: z
          .object({ id: z.string(), email: z.string(), name: z.string().nullable() })
          .nullable(),
      }),
      // Public so the dashboard can ask "am I logged in?" without a 401 loop.
      auth: 'public',
    }),
  },

  applications: {
    list: route({
      method: 'GET',
      path: '/api/admin/applications',
      response: z.array(applicationSummarySchema),
      auth: 'admin',
    }),
    create: route({
      method: 'POST',
      path: '/api/admin/applications',
      body: createApplicationInputSchema,
      response: applicationSchema,
      auth: 'admin',
    }),
    get: route({
      method: 'GET',
      path: '/api/admin/applications/:id',
      response: applicationSummarySchema,
      auth: 'admin',
    }),
    update: route({
      method: 'PATCH',
      path: '/api/admin/applications/:id',
      body: updateApplicationInputSchema,
      response: applicationSchema,
      auth: 'admin',
    }),
    remove: route({
      method: 'DELETE',
      path: '/api/admin/applications/:id',
      response: okResponseSchema,
      auth: 'admin',
    }),
    clientConfig: route({
      method: 'GET',
      path: '/api/admin/applications/:id/client-config',
      response: clientConfigSchema,
      auth: 'admin',
    }),
    metrics: route({
      method: 'GET',
      path: '/api/admin/applications/:id/metrics',
      response: metricsSchema,
      auth: 'admin',
    }),
    simulate: route({
      method: 'POST',
      path: '/api/admin/applications/:id/simulate-update-request',
      body: simulateRequestInputSchema,
      response: simulateRequestResultSchema,
      auth: 'admin',
      summary: 'Replay an update request server-side to diagnose device issues',
    }),
  },

  channels: {
    list: route({
      method: 'GET',
      path: '/api/admin/applications/:id/channels',
      response: z.array(channelSchema),
      auth: 'admin',
    }),
    create: route({
      method: 'POST',
      path: '/api/admin/applications/:id/channels',
      body: createChannelInputSchema,
      response: channelSchema,
      auth: 'admin',
    }),
    remove: route({
      method: 'DELETE',
      path: '/api/admin/channels/:channelId',
      response: okResponseSchema,
      auth: 'admin',
    }),
  },

  deployments: {
    list: route({
      method: 'GET',
      path: '/api/admin/applications/:id/deployments',
      response: z.array(deploymentSchema),
      auth: 'admin',
    }),
    history: route({
      method: 'GET',
      path: '/api/admin/applications/:id/deployment-events',
      response: z.array(deploymentEventSchema),
      auth: 'admin',
    }),
    rollBackToEmbedded: route({
      method: 'POST',
      path: '/api/admin/applications/:id/deployments/roll-back-to-embedded',
      body: rollbackToEmbeddedInputSchema,
      response: okResponseSchema,
      auth: 'admin',
      summary: 'Kill-switch: tell devices to run the bundle embedded in their binary',
    }),
  },

  releases: {
    list: route({
      method: 'GET',
      path: '/api/admin/applications/:id/releases',
      response: z.array(releaseSchema),
      auth: 'admin',
    }),
    get: route({
      method: 'GET',
      path: '/api/admin/releases/:releaseId',
      response: releaseDetailSchema,
      auth: 'admin',
    }),
    remove: route({
      method: 'DELETE',
      path: '/api/admin/releases/:releaseId',
      response: okResponseSchema,
      auth: 'admin',
    }),
    /**
     * Raw `application/zip` body rather than multipart/form-data: Bun's
     * `req.formData()` buffers the whole body in memory, so a 200 MB upload
     * becomes 200 MB of RSS. Metadata travels in the query string.
     */
    import: route({
      method: 'POST',
      path: '/api/admin/applications/:id/releases/import',
      query: importReleaseQuerySchema,
      response: importReleaseResultSchema,
      auth: 'admin',
      contentType: 'binary',
    }),
    publish: route({
      method: 'POST',
      path: '/api/admin/releases/:releaseId/publish',
      body: publishInputSchema,
      response: publishResultSchema,
      auth: 'admin',
    }),
    promote: route({
      method: 'POST',
      path: '/api/admin/releases/:releaseId/promote',
      body: promoteInputSchema,
      response: publishResultSchema,
      auth: 'admin',
    }),
    rollback: route({
      method: 'POST',
      path: '/api/admin/releases/:releaseId/rollback',
      body: rollbackInputSchema,
      response: publishResultSchema,
      auth: 'admin',
      summary: 'Create a NEW release from this one’s contents and publish it',
    }),
  },

  signing: {
    get: route({
      method: 'GET',
      path: '/api/admin/applications/:id/signing',
      response: z.object({ keys: z.array(signingKeySchema) }),
      auth: 'admin',
    }),
    generate: route({
      method: 'POST',
      path: '/api/admin/applications/:id/signing/generate',
      body: z.object({
        keyId: z.string().min(1).max(64).default('main'),
        commonName: z.string().min(1).max(128).optional(),
        validityYears: z.number().int().min(1).max(20).default(10),
      }),
      response: signingKeySchema,
      auth: 'admin',
      summary: 'Generate an RSA-2048 code signing key and self-signed certificate',
    }),
  },
} as const;

export type Contracts = typeof contracts;
