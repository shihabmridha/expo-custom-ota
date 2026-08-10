import { PLATFORMS, UPDATE_REQUEST_RESULTS } from '@oat/types';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk } from './_shared.ts';
import { applications } from './applications.ts';

/**
 * Daily counters, incremented by upsert.
 *
 * Pre-aggregated rather than an event log so storage stays bounded. This is
 * operational counting only — no device identifiers, no per-install tracking,
 * no adoption analytics. Those are explicit V1 non-goals.
 */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    id: uuidPk(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** `YYYY-MM-DD` in UTC. */
    day: text('day').notNull(),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    result: text('result', { enum: UPDATE_REQUEST_RESULTS }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('usage_daily_unique').on(t.applicationId, t.day, t.platform, t.result),
    check('usage_daily_platform_check', sql`platform IN ('ios', 'android')`),
  ],
);
