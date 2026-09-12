import { DEVICE_CLIENT_ID_SOURCES, DEVICE_EVENT_KINDS, PLATFORMS } from '@ota/types';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk } from './_shared.ts';
import { applications } from './applications.ts';

/**
 * Per-install update tracking.
 *
 * Spec §44 forbids install tracking in V1; this is a deliberate, recorded
 * departure — see D16 in `docs/decisions.md`. The line that must hold is that
 * these tables are *observability only*. Nothing in the update-selection path
 * may ever read them: tracking is not targeting, and targeting stays a non-goal.
 */

/**
 * Current state of one install of one application.
 *
 * Exactly one row per (application, client id), maintained by a single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` on the device path — no
 * read-modify-write, per D3. This table answers "what is each install running";
 * `device_update_events` answers "who received update X".
 *
 * This is a per-*install* identity, not a person. Reinstalling the app mints a
 * fresh `eas-client-id` and therefore a new row.
 */
export const deviceInstalls = sqliteTable(
  'device_installs',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /**
     * `eas-client-id`, or a fallback — see `client_id_source`. Scoped to the
     * application: one physical install talking to two applications is two
     * rows, which is the isolation invariant rather than a bug.
     */
    clientId: text('client_id').notNull(),
    clientIdSource: text('client_id_source', { enum: DEVICE_CLIENT_ID_SOURCES }).notNull(),

    /** Application-supplied, opaque, may be absent. Never required. */
    userId: text('user_id'),

    /**
     * Device facts the app chose to send via `expo-extra-params` (D18). For a
     * human debugging one install, not for selection — nothing in the update
     * path may read them. Sticky on upsert like `user_id`: a poll that omits
     * them keeps the last known value.
     */
    osVersion: text('os_version'),
    deviceBrand: text('device_brand'),
    deviceModel: text('device_model'),

    platform: text('platform', { enum: PLATFORMS }).notNull(),
    channelName: text('channel_name').notNull(),
    runtimeVersion: text('runtime_version').notNull(),

    /** Last `expo-current-update-id` reported — what the install is running. */
    currentUpdateId: text('current_update_id'),
    sourceRevision: text('source_revision'),
    /** When `current_update_id` last *changed*. "Running X since." */
    currentUpdateSince: integer('current_update_since', { mode: 'timestamp_ms' }),
    /** Last `expo-embedded-update-id` — the bundle baked into its binary. */
    embeddedUpdateId: text('embedded_update_id'),

    /** Last update we actually handed this install a manifest for. */
    lastServedUpdateId: text('last_served_update_id'),
    lastServedAt: integer('last_served_at', { mode: 'timestamp_ms' }),

    /**
     * The `current_update_id` whose confirmation transition has already been
     * processed. A write-amplification gate, NOT a claim that we served that
     * update — `device_update_events` is the authority on that. Keeping it here
     * is what makes a steady-state poll exactly one write instead of three.
     */
    confirmedUpdateId: text('confirmed_update_id'),

    requestCount: integer('request_count').notNull().default(0),

    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** The upsert target. Without this the whole design collapses to read-modify-write. */
    uniqueIndex('device_installs_app_client_unique').on(t.applicationId, t.clientId),
    /** "How many installs are on update X" — the dashboard's headline query. */
    index('device_installs_app_current_idx').on(t.applicationId, t.currentUpdateId),
    /** Default list ordering, "active in the last N days", and the prune scan. */
    index('device_installs_app_seen_idx').on(t.applicationId, t.lastSeenAt),
    /** Partial: most rows carry no user id, so this index stays small. */
    index('device_installs_app_user_idx')
      .on(t.applicationId, t.userId)
      .where(sql`user_id IS NOT NULL`),
    check('device_installs_platform_check', sql`platform IN ('ios', 'android')`),
    check(
      'device_installs_client_id_source_check',
      sql`client_id_source IN ('eas', 'extra', 'user')`,
    ),
  ],
);

/**
 * Append-only transition log. One row per (install, update, kind) — never one
 * per request.
 *
 * The unique index is the mechanism, not a safety net: every append is
 * `ON CONFLICT DO NOTHING` against it, so an install polling on every launch for
 * a year adds nothing after its first row. Growth is bounded by
 * installs × updates-they-touch × 2, independent of poll frequency.
 *
 * Deliberately NOT foreign-keyed to `device_installs` or `release_variants`:
 * retention prunes the two tables on different criteria (last-seen vs. event
 * age), and a cascade would destroy adoption history when a device merely goes
 * quiet or a release is deleted.
 */
export const deviceUpdateEvents = sqliteTable(
  'device_update_events',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    /** A `release_variants.update_id`. Not an FK — a deleted release must not erase history. */
    updateId: text('update_id').notNull(),
    kind: text('kind', { enum: DEVICE_EVENT_KINDS }).notNull(),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** THE load-bearing constraint. It is what makes every append idempotent. */
    uniqueIndex('device_update_events_unique').on(t.applicationId, t.clientId, t.updateId, t.kind),
    /** "Who received update X", and the served/confirmed counts. */
    index('device_update_events_app_update_idx').on(t.applicationId, t.updateId, t.kind),
    /** Prune scan and the recent-activity feed. */
    index('device_update_events_app_created_idx').on(t.applicationId, t.createdAt),
    check('device_update_events_kind_check', sql`kind IN ('served', 'confirmed')`),
    check('device_update_events_platform_check', sql`platform IN ('ios', 'android')`),
  ],
);
