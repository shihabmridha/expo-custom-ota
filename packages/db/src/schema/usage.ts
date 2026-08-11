import { PLATFORMS, UPDATE_REQUEST_RESULTS } from '@ota/types';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk } from './_shared.ts';
import { applications } from './applications.ts';

/**
 * Daily counters, incremented by upsert.
 *
 * Pre-aggregated rather than an event log, so this table costs
 * O(days × platforms × results) no matter how much traffic arrives. That is why
 * it stays separate from `device_installs` now that per-install tracking exists
 * (D16): these counters answer "how much", the device tables answer "who", and
 * conflating them would make the cheap question as expensive as the dear one.
 *
 * Nothing here is per-device — a row is a count, never an identifier.
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
