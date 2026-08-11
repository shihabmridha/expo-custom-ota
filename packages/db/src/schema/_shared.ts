import { integer, text } from 'drizzle-orm/sqlite-core';

/**
 * Shared column builders.
 *
 * SQLite conventions, applied uniformly:
 *  - ids are `text` UUIDs generated app-side, never autoincrement integers, so
 *    externally visible resources are not enumerable
 *  - timestamps are epoch-ms integers: sortable, timezone-free, index-friendly.
 *    ISO 8601 strings appear only inside baked manifests.
 *  - statuses are plain `text` with a TS union plus a CHECK constraint — never
 *    a Postgres-style native enum.
 */

export function uuidPk() {
  return text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
}

export function createdAt() {
  return integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());
}

export function timestamps() {
  return {
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  };
}
