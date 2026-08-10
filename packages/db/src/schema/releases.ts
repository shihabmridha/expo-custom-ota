import {
  type ExpoClientConfig,
  IMPORT_STATUSES,
  PLATFORMS,
  RELEASE_ASSET_TYPES,
  RELEASE_STATUSES,
} from '@oat/types';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, timestamps, uuidPk } from './_shared.ts';
import { applications } from './applications.ts';
import { assets } from './assets.ts';

/** One imported Expo export, owned by exactly one application. */
export const releases = sqliteTable(
  'releases',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /** Application-local counter: every app starts at #1. */
    releaseNumber: integer('release_number').notNull(),

    message: text('message'),
    status: text('status', { enum: RELEASE_STATUSES }).notNull().default('draft'),

    /** Import state machine — a release is only publishable at `ready`. */
    importStatus: text('import_status', { enum: IMPORT_STATUSES }).notNull().default('uploaded'),
    importError: text('import_error'),

    sourceFilename: text('source_filename'),
    sourceHash: text('source_hash'),
    sourceStorageKey: text('source_storage_key'),
    sourceSizeBytes: integer('source_size_bytes'),

    /** Retried uploads resolve to the same release instead of duplicating. */
    idempotencyKey: text('idempotency_key'),

    /** Set when this release was produced by rolling back to another one. */
    rollbackOfReleaseId: text('rollback_of_release_id'),

    createdBy: text('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('releases_app_number_unique').on(t.applicationId, t.releaseNumber),
    uniqueIndex('releases_app_idempotency_unique').on(t.applicationId, t.idempotencyKey),
    index('releases_app_status_idx').on(t.applicationId, t.status),
    check('releases_status_check', sql`status IN ('draft', 'published', 'archived')`),
    check(
      'releases_import_status_check',
      sql`import_status IN ('uploaded', 'processing', 'assets_uploaded', 'ready', 'failed')`,
    ),
  ],
);

/**
 * The per-platform half of a release. A single export may contain Android, iOS
 * or both, and each gets its own update id, manifest and signature.
 */
export const releaseVariants = sqliteTable(
  'release_variants',
  {
    id: uuidPk(),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),

    platform: text('platform', { enum: PLATFORMS }).notNull(),

    /**
     * Stored at import time from the uploaded expoConfig — never echoed from
     * the client's `expo-runtime-version` header. The official reference server
     * echoes it, which means it asserts whatever the client claims.
     */
    runtimeVersion: text('runtime_version').notNull(),

    /** UUID-formatted; the client parses it with `UUID.fromString`. */
    updateId: text('update_id').notNull(),

    /**
     * The EXACT serialized manifest string that was signed.
     *
     * Plain `text`, deliberately NOT `{ mode: 'json' }`. Drizzle's json mode
     * would parse on read and re-serialize on write, changing the bytes and
     * silently invalidating the signature — the protocol has no
     * canonicalization step. Do not "fix" this.
     */
    manifest: text('manifest').notNull(),
    /** Standard base64 (padded), not base64url. */
    manifestSignature: text('manifest_signature'),
    /** Which signing key produced the signature; must match the client config. */
    signingKeyId: text('signing_key_id'),

    launchAssetId: text('launch_asset_id')
      .notNull()
      .references(() => assets.id),

    expoConfig: text('expo_config', { mode: 'json' }).$type<ExpoClientConfig>(),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('release_variants_update_id_unique').on(t.updateId),
    // A release has at most one variant per platform.
    uniqueIndex('release_variants_release_platform_unique').on(t.releaseId, t.platform),
    index('release_variants_release_idx').on(t.releaseId),
    check('release_variants_platform_check', sql`platform IN ('ios', 'android')`),
  ],
);

/**
 * Join between a variant and the immutable assets it needs.
 *
 * The physical object may be shared across releases and applications; this
 * table keeps each application's *metadata* separate, and its `asset_id` index
 * is what makes reference-counted garbage collection possible.
 */
export const releaseAssets = sqliteTable(
  'release_assets',
  {
    id: uuidPk(),
    releaseVariantId: text('release_variant_id')
      .notNull()
      .references(() => releaseVariants.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id),

    /** The manifest `asset.key` — hex MD5 in our importer. */
    assetKey: text('asset_key').notNull(),
    type: text('type', { enum: RELEASE_ASSET_TYPES }).notNull(),
    /** Metro extension, no leading dot. Null for the launch asset. */
    fileExtension: text('file_extension'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    uniqueIndex('release_assets_variant_key_unique').on(t.releaseVariantId, t.assetKey),
    index('release_assets_asset_idx').on(t.assetId),
    check('release_assets_type_check', sql`type IN ('launch', 'asset')`),
  ],
);
