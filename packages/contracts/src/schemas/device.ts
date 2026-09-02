import { z } from 'zod';
import { paginationQuerySchema, platformSchema } from './common.ts';

/**
 * Per-install tracking, read side.
 *
 * `clientIdSource` is part of every install payload on purpose: an `eas` or
 * `extra` row is one install, but a `user` row is one *user* with their devices
 * collapsed together, so a UI that hides the source quietly misreports.
 */
export const deviceClientIdSourceSchema = z.enum(['eas', 'extra', 'user']);

/** App-supplied via `expo-extra-params`; any of them may be absent. */
const deviceFactsSchema = {
  osVersion: z.string().nullable(),
  deviceBrand: z.string().nullable(),
  deviceModel: z.string().nullable(),
};

export const deviceInstallSchema = z.object({
  clientId: z.string(),
  clientIdSource: deviceClientIdSourceSchema,
  userId: z.string().nullable(),
  ...deviceFactsSchema,
  platform: platformSchema,
  channelName: z.string(),
  runtimeVersion: z.string(),
  currentUpdateId: z.string().nullable(),
  currentUpdateSince: z.string().nullable(),
  /** Release number of `currentUpdateId`, when it is one of ours. */
  currentReleaseNumber: z.number().int().nullable(),
  embeddedUpdateId: z.string().nullable(),
  lastServedUpdateId: z.string().nullable(),
  lastServedAt: z.string().nullable(),
  requestCount: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

export const deviceListQuerySchema = paginationQuerySchema.extend({
  platform: platformSchema.optional(),
  channel: z.string().max(64).optional(),
  runtimeVersion: z.string().max(128).optional(),
  updateId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  /** Exact matches, like every other filter here. */
  osVersion: z.string().max(64).optional(),
  deviceBrand: z.string().max(64).optional(),
  /** Only installs seen within the last N days. */
  activeWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const deviceListSchema = z.object({
  items: z.array(deviceInstallSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

/** The adoption funnel: how many installs are on each update. */
export const deviceAdoptionSchema = z.object({
  /** False when DEVICE_TRACKING_ENABLED is off, so the UI can say so plainly. */
  trackingEnabled: z.boolean(),
  totals: z.object({
    installs: z.number().int(),
    activeLast24h: z.number().int(),
    activeLast7d: z.number().int(),
  }),
  byUpdate: z.array(
    z.object({
      updateId: z.string(),
      releaseNumber: z.number().int().nullable(),
      platform: platformSchema.nullable(),
      runtimeVersion: z.string().nullable(),
      /** Installs whose `currentUpdateId` is this update right now. */
      running: z.number().int(),
      served: z.number().int(),
      confirmed: z.number().int(),
    }),
  ),
});

export const deviceRecipientsQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(['served', 'confirmed', 'any']).default('any'),
});

/** "Who received update X." */
export const deviceRecipientsSchema = z.object({
  updateId: z.string(),
  served: z.number().int(),
  confirmed: z.number().int(),
  items: z.array(
    z.object({
      clientId: z.string(),
      clientIdSource: deviceClientIdSourceSchema.nullable(),
      userId: z.string().nullable(),
      ...deviceFactsSchema,
      platform: platformSchema,
      servedAt: z.string().nullable(),
      confirmedAt: z.string().nullable(),
      /** False once the install has moved on to something else. */
      stillRunning: z.boolean(),
    }),
  ),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type DeviceInstall = z.infer<typeof deviceInstallSchema>;
export type DeviceList = z.infer<typeof deviceListSchema>;
export type DeviceAdoption = z.infer<typeof deviceAdoptionSchema>;
export type DeviceRecipients = z.infer<typeof deviceRecipientsSchema>;
