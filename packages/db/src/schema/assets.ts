import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, uuidPk } from './_shared.ts';

/**
 * Content-addressed, immutable, globally deduplicated.
 *
 * Deliberately NOT scoped to an application: two apps that bundle the same PNG
 * share one physical object, which is safe precisely because the object is
 * addressed by the hash of its contents and never overwritten. Application
 * isolation lives in `release_assets`, which is scoped through the variant.
 *
 * Never cascade-delete from here — a row may be referenced by many releases
 * across many applications. Removal goes through reference-counted GC.
 */
export const assets = sqliteTable(
  'assets',
  {
    id: uuidPk(),
    /** Hex SHA-256 of the raw bytes. */
    sha256: text('sha256').notNull(),
    /** `sha256/<ab>/<full-hex>`, POSIX separators always. */
    storageKey: text('storage_key').notNull(),

    contentType: text('content_type').notNull(),
    /** Metro extension with no leading dot; null for launch bundles. */
    fileExtension: text('file_extension'),
    sizeBytes: integer('size_bytes').notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('assets_sha256_unique').on(t.sha256),
    uniqueIndex('assets_storage_key_unique').on(t.storageKey),
    index('assets_created_at_idx').on(t.createdAt),
  ],
);
