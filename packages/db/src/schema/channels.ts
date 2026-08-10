import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, uuidPk } from './_shared.ts';
import { applications } from './applications.ts';

/**
 * A named deployment track within one application.
 *
 * `production` and `staging` are created automatically with every application.
 * The unique index is scoped to the application, so `Acadion.production` and
 * `Lekho.production` are unrelated rows — which is the whole point of a
 * multi-application platform.
 */
export const channels = sqliteTable(
  'channels',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channels_app_name_unique').on(t.applicationId, t.name),
    index('channels_app_idx').on(t.applicationId),
  ],
);
