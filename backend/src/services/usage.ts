import type { OtaDatabase } from '@ota/db';
import { usageDaily } from '@ota/db';
import type { Platform, UpdateRequestResult } from '@ota/types';
import { sql } from 'drizzle-orm';
import type { TrackingDiagnostics } from '../lib/tracking-diagnostics.ts';

/**
 * Operational counters.
 *
 * Pre-aggregated per day so storage stays bounded regardless of traffic. These
 * are counts only, never identifiers: per-install tracking lives in
 * `device-tracking.ts` and is deliberately a separate write with a separate
 * off switch (D16).
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
  diagnostics?: TrackingDiagnostics,
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
    diagnostics?.failure('usage', applicationId);
    // Counters must never break update delivery. An installed app staying
    // usable matters more than a metric.
  }
}
