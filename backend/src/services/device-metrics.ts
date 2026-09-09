import type { DeviceMetrics, deviceMetricsQuerySchema } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';

const DAY = 86_400_000;

/** Retained observations only; never consulted by update selection. */
export async function getDeviceMetrics(
  db: OtaDatabase,
  applicationId: string,
  query: z.infer<typeof deviceMetricsQuerySchema>,
  trackingEnabled: boolean,
  retentionDays: number,
  now = new Date(),
): Promise<DeviceMetrics> {
  const timestamp = now.getTime();
  const scope = sql`application_id = ${applicationId}
    ${query.channel ? sql`AND channel_name = ${query.channel}` : sql``}
    ${query.platform ? sql`AND platform = ${query.platform}` : sql``}
    ${query.runtimeVersion ? sql`AND runtime_version = ${query.runtimeVersion}` : sql``}`;
  const [totals] = await db.all<DeviceMetrics['inactivity'] & { userFallbackRecords: number }>(sql`
    SELECT
      count(CASE WHEN client_id_source = 'user' THEN 1 END) AS userFallbackRecords,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at >= ${timestamp - 7 * DAY} THEN 1 END) AS within7d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 7 * DAY} AND last_seen_at >= ${timestamp - 30 * DAY} THEN 1 END) AS over7Through30d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 30 * DAY} AND last_seen_at >= ${timestamp - 60 * DAY} THEN 1 END) AS over30Through60d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 60 * DAY} THEN 1 END) AS over60d
    FROM device_installs WHERE ${scope}
  `);
  const groups = await db.all<DeviceMetrics['groups'][number]>(sql`
    WITH targets AS (
      SELECT d.application_id, c.name AS channel_name, d.platform, d.runtime_version,
        v.update_id, r.release_number,
        CASE WHEN d.directive IS NOT NULL THEN 'rollback' ELSE 'update' END AS state
      FROM deployments d JOIN channels c ON c.id = d.channel_id AND c.application_id = d.application_id
      LEFT JOIN release_variants v ON v.id = d.release_variant_id
      LEFT JOIN releases r ON r.id = v.release_id
      WHERE d.application_id = ${applicationId}
    ), cohorts AS (
      SELECT application_id, channel_name, platform, runtime_version FROM device_installs
        WHERE ${scope} AND client_id_source != 'user'
      UNION
      SELECT application_id, channel_name, platform, runtime_version FROM targets WHERE ${scope}
    ), counts AS (
      SELECT g.channel_name AS channelName, g.platform, g.runtime_version AS runtimeVersion,
        coalesce(t.state, 'none') AS deploymentState, t.update_id AS updateId,
        t.release_number AS releaseNumber,
        count(i.id) AS activeEligible,
        count(CASE WHEN i.current_update_id = t.update_id THEN 1 END) AS activeOnTarget,
        count(CASE WHEN i.id IS NOT NULL AND i.current_update_id IS NULL THEN 1 END) AS unknownCurrentUpdate
      FROM cohorts g LEFT JOIN targets t ON t.channel_name = g.channel_name
        AND t.platform = g.platform AND t.runtime_version = g.runtime_version
      LEFT JOIN device_installs i ON i.application_id = g.application_id
        AND i.channel_name = g.channel_name AND i.platform = g.platform AND i.runtime_version = g.runtime_version
        AND i.client_id_source != 'user' AND i.last_seen_at >= ${timestamp - query.activeWithinDays * DAY}
      GROUP BY g.channel_name, g.platform, g.runtime_version
    )
    SELECT *, CASE WHEN deploymentState = 'update' AND updateId IS NOT NULL AND activeEligible > 0
      THEN 100.0 * activeOnTarget / activeEligible ELSE NULL END AS adoptionPercent
    FROM counts ORDER BY channelName, platform, runtimeVersion
  `);
  return {
    calculatedAt: now.toISOString(),
    trackingEnabled,
    retentionDays,
    activeWithinDays: query.activeWithinDays,
    userFallbackRecords: totals?.userFallbackRecords ?? 0,
    inactivity: {
      within7d: totals?.within7d ?? 0,
      over7Through30d: totals?.over7Through30d ?? 0,
      over30Through60d: totals?.over30Through60d ?? 0,
      over60d: totals?.over60d ?? 0,
    },
    groups,
  };
}
