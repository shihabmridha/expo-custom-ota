import type { Platform } from './platform.ts';

export const RELEASE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * Import state machine. Object storage and the database cannot be one
 * distributed transaction, so an explicit state machine guards against exposing
 * a half-imported release as publishable.
 */
export const IMPORT_STATUSES = [
  'uploaded',
  'processing',
  'assets_uploaded',
  'ready',
  'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const SIGNING_KEY_STATUSES = ['active', 'retired'] as const;
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number];

export const RELEASE_ASSET_TYPES = ['launch', 'asset'] as const;
export type ReleaseAssetType = (typeof RELEASE_ASSET_TYPES)[number];

export const DEPLOYMENT_ACTIONS = [
  'publish',
  'promote',
  'rollback',
  'rollback_to_embedded',
  'clear',
] as const;
export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[number];

/** Outcome of a public update request, used for logging and daily counters. */
export const UPDATE_REQUEST_RESULTS = [
  'update_served',
  'no_update_available',
  'roll_back_to_embedded',
  'error',
] as const;
export type UpdateRequestResult = (typeof UPDATE_REQUEST_RESULTS)[number];

/**
 * Which identifier keyed a `device_installs` row. See `resolveDeviceIdentity`.
 *
 * `eas` and `extra` are per install; `user` is per *user* and therefore
 * collapses one person's devices into a single row. The dashboard must surface
 * this, or a `user`-keyed row reads as an install and quietly misleads.
 */
export const DEVICE_CLIENT_ID_SOURCES = ['eas', 'extra', 'user'] as const;
export type DeviceClientIdSource = (typeof DEVICE_CLIENT_ID_SOURCES)[number];

/**
 * `served`    — we handed this install the manifest for an update.
 * `confirmed` — a later request reported it is now *running* that update.
 *
 * The pair is the install funnel: served without confirmed means downloaded but
 * never launched, or launched and rejected (a signature mismatch, say).
 */
export const DEVICE_EVENT_KINDS = ['served', 'confirmed'] as const;
export type DeviceEventKind = (typeof DEVICE_EVENT_KINDS)[number];

/** Deployment target tuple. Never resolve an update without all four. */
export interface DeploymentTarget {
  applicationId: string;
  channelId: string;
  platform: Platform;
  runtimeVersion: string;
}
