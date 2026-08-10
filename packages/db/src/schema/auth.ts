import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps, uuidPk } from './_shared.ts';

/** Administrators. There is no registration route; use `bun run admin:create`. */
export const admins = sqliteTable(
  'admins',
  {
    id: uuidPk(),
    email: text('email').notNull(),
    /** argon2id via `Bun.password`. */
    passwordHash: text('password_hash').notNull(),
    name: text('name'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('admins_email_unique').on(t.email)],
);

/**
 * Sessions.
 *
 * The cookie carries 32 random bytes; only the SHA-256 of that value is stored,
 * so a database dump cannot be replayed to forge a session.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: uuidPk(),
    adminId: text('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Hashed, so a session table leak does not expose client IPs. */
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_admin_idx').on(t.adminId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);
