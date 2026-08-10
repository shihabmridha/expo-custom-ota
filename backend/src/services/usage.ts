import type { OtaDatabase } from '@ota/db';
import { usageDaily } from '@ota/db';
import type { Platform, UpdateRequestResult } from '@ota/types';
import { sql } from 'drizzle-orm';

/**
 * Operational counters.
 *
 * Pre-aggregated per day so storage stays bounded regardless of traffic. No
 * device identifiers, no per-install tracking — those are explicit non-goals.
 */
function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function recordUpdateRequest(
  db: OtaDatabase,
  applicationId: string,
  platform: Platform,
  result: UpdateRequestResult,
  now = new Date(),
): Promise<void> {
  try {
    await db
      .insert(usageDaily)
      .values({ applicationId, day: utcDay(now), platform, result, count: 1 })
      .onConflictDoUpdate({
        target: [usageDaily.applicationId, usageDaily.day, usageDaily.platform, usageDaily.result],
        set: { count: sql`${usageDaily.count} + 1` },
      });
  } catch {
    // Counters must never break update delivery. An installed app staying
    // usable matters more than a metric.
  }
}
