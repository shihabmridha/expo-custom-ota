import { SIGNING_KEY_STATUSES } from '@oat/types';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps, uuidPk } from './_shared.ts';

/**
 * An Application is the top-level OTA entity.
 *
 * Deliberately not called "Project": Expo uses that word for several different
 * concepts. Every channel, release, deployment, signing key and update
 * selection hangs off exactly one application — that is the isolation
 * invariant, and it is enforced here with foreign keys and composite unique
 * indexes rather than left to application code.
 */
export const applications = sqliteTable(
  'applications',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /**
     * Public identifier in the OTA URL. Not an authentication secret — it only
     * selects which application a device is talking to.
     */
    updateKey: text('update_key').notNull(),
    description: text('description'),

    /** Compared against the uploaded expoConfig to catch cross-app uploads. */
    androidPackage: text('android_package'),
    iosBundleIdentifier: text('ios_bundle_identifier'),

    /** Used when a device sends no `expo-channel-name` header. */
    defaultChannel: text('default_channel').notNull().default('production'),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('applications_slug_unique').on(t.slug),
    uniqueIndex('applications_update_key_unique').on(t.updateKey),
  ],
);

/**
 * Per-application signing identity.
 *
 * Each application gets its own key so a compromise is contained. The private
 * key is NEVER stored here — `privateKeyRef` points at a file under
 * SIGNING_KEYS_DIRECTORY, which in production is a mounted secret.
 */
export const applicationSigningKeys = sqliteTable(
  'application_signing_keys',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /** Must match the client's `codeSigningMetadata.keyid` exactly. */
    keyId: text('key_id').notNull(),

    certificatePem: text('certificate_pem').notNull(),
    certificateFingerprint: text('certificate_fingerprint').notNull(),
    certificateNotAfter: integer('certificate_not_after', { mode: 'timestamp_ms' }).notNull(),

    /** Filesystem path or secret reference — never the key material itself. */
    privateKeyRef: text('private_key_ref').notNull(),

    status: text('status', { enum: SIGNING_KEY_STATUSES }).notNull().default('active'),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('signing_keys_app_keyid_unique').on(t.applicationId, t.keyId),
    /**
     * Partial unique index: at most one active key per application. SQLite
     * supports these, so the invariant is enforced by the database rather than
     * by a service-layer check that a concurrent request could race.
     */
    uniqueIndex('signing_keys_one_active_per_app')
      .on(t.applicationId)
      .where(sql`status = 'active'`),
    index('signing_keys_app_idx').on(t.applicationId),
    check('signing_keys_status_check', sql`status IN ('active', 'retired')`),
  ],
);
