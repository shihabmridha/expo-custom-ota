import type { DeviceMetrics, deviceMetricsQuerySchema } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';

const DAY = 86_400_000;

type Group = DeviceMetrics['groups'][number];
type CountRow = Omit<Group, 'deployedAt' | 'served' | 'confirmed' | 'timeline' | 'running'> & {
  deployedAt: number | null;
};
type RunningRow = Group['running'][number] &
  Pick<Group, 'channelName' | 'platform' | 'runtimeVersion'>;
type TimelineRow = Group['timeline'][number] & { updateId: string };

const cohortKey = (row: Pick<Group, 'channelName' | 'platform' | 'runtimeVersion'>) =>
  JSON.stringify([row.channelName, row.platform, row.runtimeVersion]);

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
  const activeCutoff = timestamp - query.activeWithinDays * DAY;
  const scope = sql`application_id = ${applicationId}
    ${query.channel ? sql`AND channel_name = ${query.channel}` : sql``}
    ${query.platform ? sql`AND platform = ${query.platform}` : sql``}
    ${query.runtimeVersion ? sql`AND runtime_version = ${query.runtimeVersion}` : sql``}`;
  const [totals] = await db.all<
    DeviceMetrics['inactivity'] & { userFallbackRecords: number; last1d: number; last30d: number }
  >(sql`
    SELECT
      count(CASE WHEN client_id_source = 'user' THEN 1 END) AS userFallbackRecords,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at >= ${timestamp - DAY} THEN 1 END) AS last1d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at >= ${timestamp - 7 * DAY} THEN 1 END) AS within7d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at >= ${timestamp - 30 * DAY} THEN 1 END) AS last30d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 7 * DAY} AND last_seen_at >= ${timestamp - 30 * DAY} THEN 1 END) AS over7Through30d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 30 * DAY} AND last_seen_at >= ${timestamp - 60 * DAY} THEN 1 END) AS over30Through60d,
      count(CASE WHEN client_id_source != 'user' AND last_seen_at < ${timestamp - 60 * DAY} THEN 1 END) AS over60d
    FROM device_installs WHERE ${scope}
  `);
  const counts = await db.all<CountRow>(sql`
    WITH targets AS (
      SELECT d.application_id, c.name AS channel_name, d.platform, d.runtime_version,
        v.update_id, r.release_number, d.updated_at,
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
        t.release_number AS releaseNumber, t.updated_at AS deployedAt,
        count(i.id) AS activeEligible,
        count(CASE WHEN i.current_update_id = t.update_id THEN 1 END) AS activeOnTarget,
        count(CASE WHEN i.id IS NOT NULL AND i.current_update_id IS NULL THEN 1 END) AS unknownCurrentUpdate
      FROM cohorts g LEFT JOIN targets t ON t.channel_name = g.channel_name
        AND t.platform = g.platform AND t.runtime_version = g.runtime_version
      LEFT JOIN device_installs i ON i.application_id = g.application_id
        AND i.channel_name = g.channel_name AND i.platform = g.platform AND i.runtime_version = g.runtime_version
        AND i.client_id_source != 'user' AND i.last_seen_at >= ${activeCutoff}
      GROUP BY g.channel_name, g.platform, g.runtime_version
    )
    SELECT *, CASE WHEN deploymentState = 'update' AND updateId IS NOT NULL AND activeEligible > 0
      THEN 100.0 * activeOnTarget / activeEligible ELSE NULL END AS adoptionPercent
    FROM counts ORDER BY channelName, platform, runtimeVersion
  `);

  // What each cohort's active installs run. The filtered subquery keeps the
  // unqualified scope columns unambiguous against the joined release tables;
  // the release join is application-scoped so another tenant's update id never
  // lends this one a release number.
  const running = await db.all<RunningRow>(sql`
    SELECT i.channel_name AS channelName, i.platform, i.runtime_version AS runtimeVersion,
      i.current_update_id AS updateId, r.release_number AS releaseNumber,
      CASE WHEN i.current_update_id IS NULL OR i.embedded_update_id IS NULL THEN 'unknown'
        WHEN i.current_update_id = i.embedded_update_id THEN 'embedded'
        ELSE 'downloaded' END AS launchKind,
      count(*) AS installs
    FROM (SELECT * FROM device_installs WHERE ${scope} AND client_id_source != 'user'
      AND last_seen_at >= ${activeCutoff}) i
    LEFT JOIN release_variants v ON v.update_id = i.current_update_id
    LEFT JOIN releases r ON r.id = v.release_id AND r.application_id = i.application_id
    GROUP BY channelName, i.platform, runtimeVersion, updateId, releaseNumber, launchKind
    ORDER BY installs DESC, releaseNumber DESC NULLS LAST, updateId NULLS LAST, launchKind
  `);

  const targetIds = [...new Set(counts.flatMap((g) => (g.updateId ? [g.updateId] : [])))];
  const timeline: TimelineRow[] =
    targetIds.length === 0
      ? []
      : await db.all<TimelineRow>(sql`
          SELECT update_id AS updateId,
            strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
            count(CASE WHEN kind = 'served' THEN 1 END) AS served,
            count(CASE WHEN kind = 'confirmed' THEN 1 END) AS confirmed
          FROM device_update_events
          WHERE application_id = ${applicationId} AND update_id IN ${inList(targetIds)}
          GROUP BY update_id, day ORDER BY day
        `);

  const runningByCohort = groupBy(running, cohortKey);
  const timelineByUpdate = groupBy(timeline, (row) => row.updateId);

  return {
    calculatedAt: now.toISOString(),
    trackingEnabled,
    retentionDays,
    activeWithinDays: query.activeWithinDays,
    userFallbackRecords: totals?.userFallbackRecords ?? 0,
    activeInstalls: {
      last1d: totals?.last1d ?? 0,
      last7d: totals?.within7d ?? 0,
      last30d: totals?.last30d ?? 0,
    },
    inactivity: {
      within7d: totals?.within7d ?? 0,
      over7Through30d: totals?.over7Through30d ?? 0,
      over30Through60d: totals?.over30Through60d ?? 0,
      over60d: totals?.over60d ?? 0,
    },
    groups: counts.map(({ deployedAt, ...group }) => {
      const days = (group.updateId && timelineByUpdate.get(group.updateId)) || [];
      return {
        ...group,
        deployedAt: deployedAt === null ? null : new Date(deployedAt).toISOString(),
        served: days.reduce((sum, d) => sum + d.served, 0),
        confirmed: days.reduce((sum, d) => sum + d.confirmed, 0),
        timeline: days.map(({ day, served, confirmed }) => ({ day, served, confirmed })),
        running: (runningByCohort.get(cohortKey(group)) ?? []).map(
          ({ updateId, releaseNumber, launchKind, installs }) => ({
            updateId,
            releaseNumber,
            launchKind,
            installs,
          }),
        ),
      };
    }),
  };
}

function inList(values: string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}
