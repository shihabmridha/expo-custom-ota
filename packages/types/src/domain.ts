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

/** Deployment target tuple. Never resolve an update without all four. */
export interface DeploymentTarget {
  applicationId: string;
  channelId: string;
  platform: Platform;
  runtimeVersion: string;
}
