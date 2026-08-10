import { DEPLOYMENT_ACTIONS, PLATFORMS } from '@ota/types';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, uuidPk } from './_shared.ts';
import { applications } from './applications.ts';
import { channels } from './channels.ts';
import { releaseVariants } from './releases.ts';

/**
 * What is currently served for a given (application, channel, platform,
 * runtime) tuple.
 *
 * The composite unique index is the single most important constraint in the
 * schema: it makes concurrent publishes deterministic via upsert, and it makes
 * it structurally impossible to resolve an update without naming an
 * application.
 */
export const deployments = sqliteTable(
  'deployments',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),

    platform: text('platform', { enum: PLATFORMS }).notNull(),
    runtimeVersion: text('runtime_version').notNull(),

    /**
     * Null when this deployment serves a directive instead of an update — see
     * the CHECK below.
     */
    releaseVariantId: text('release_variant_id').references(() => releaseVariants.id),

    /**
     * `rollBackToEmbedded` kill-switch.
     *
     * This is the only mechanism that un-ships a bad update to devices that
     * already took it, without publishing new JS. Mutually exclusive with
     * `release_variant_id`.
     */
    directive: text('directive'),
    directiveCommitTime: integer('directive_commit_time', { mode: 'timestamp_ms' }),

    /** Optimistic-concurrency counter, bumped on every upsert. */
    version: integer('version').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('deployments_target_unique').on(
      t.applicationId,
      t.channelId,
      t.platform,
      t.runtimeVersion,
    ),
    index('deployments_app_channel_idx').on(t.applicationId, t.channelId),
    index('deployments_variant_idx').on(t.releaseVariantId),
    check('deployments_platform_check', sql`platform IN ('ios', 'android')`),
    check(
      'deployments_directive_check',
      sql`directive IS NULL OR directive = 'rollBackToEmbedded'`,
    ),
    // Exactly one of the two must be set.
    check(
      'deployments_target_exclusive_check',
      sql`(release_variant_id IS NOT NULL) <> (directive IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only history of deployment changes.
 *
 * Required by the objective "view release and deployment history", which the
 * mutable `deployments` table cannot answer on its own.
 */
export const deploymentEvents = sqliteTable(
  'deployment_events',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    runtimeVersion: text('runtime_version').notNull(),

    fromVariantId: text('from_variant_id'),
    toVariantId: text('to_variant_id'),

    action: text('action', { enum: DEPLOYMENT_ACTIONS }).notNull(),
    actorAdminId: text('actor_admin_id'),

    createdAt: createdAt(),
  },
  (t) => [
    index('deployment_events_app_idx').on(t.applicationId, t.createdAt),
    check(
      'deployment_events_action_check',
      sql`action IN ('publish', 'promote', 'rollback', 'rollback_to_embedded', 'clear')`,
    ),
  ],
);
