import type { DeviceInstall } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import { deviceInstalls, releases, releaseVariants } from '@ota/db';
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';

export function installSourceRevision(
  install: { platform: string; runtimeVersion: string; sourceRevision: string | null },
  variant: { platform: string; runtimeVersion: string; sourceRevision: string | null } | undefined,
): string | null {
  if (!variant) return install.sourceRevision;
  return variant.platform === install.platform && variant.runtimeVersion === install.runtimeVersion
    ? variant.sourceRevision
    : null;
}

export function installLaunchKind(
  current: string | null,
  embedded: string | null,
): DeviceInstall['launchKind'] {
  if (!current || !embedded) return 'unknown';
  return current === embedded ? 'embedded' : 'downloaded';
}

export async function getDeviceSourceGroups(
  db: OtaDatabase,
  applicationId: string,
  filters: {
    channel?: string;
    platform?: 'android' | 'ios';
    runtimeVersion?: string;
    activeWithinDays: number;
  },
) {
  const where = [
    eq(deviceInstalls.applicationId, applicationId),
    ne(deviceInstalls.clientIdSource, 'user'),
    gte(deviceInstalls.lastSeenAt, new Date(Date.now() - filters.activeWithinDays * 86_400_000)),
  ];
  if (filters.channel) where.push(eq(deviceInstalls.channelName, filters.channel));
  if (filters.platform) where.push(eq(deviceInstalls.platform, filters.platform));
  if (filters.runtimeVersion) where.push(eq(deviceInstalls.runtimeVersion, filters.runtimeVersion));

  // An imported UUID has server-owned provenance, even when that provenance is unknown.
  const sourceRevision = sql<string | null>`CASE WHEN ${releases.id} IS NOT NULL THEN
    CASE WHEN ${releaseVariants.platform} = ${deviceInstalls.platform}
      AND ${releaseVariants.runtimeVersion} = ${deviceInstalls.runtimeVersion}
      THEN ${releases.sourceRevision} ELSE NULL END
    ELSE ${deviceInstalls.sourceRevision} END`;
  const launchKind = sql<DeviceInstall['launchKind']>`CASE
    WHEN ${deviceInstalls.currentUpdateId} IS NULL OR ${deviceInstalls.embeddedUpdateId} IS NULL THEN 'unknown'
    WHEN ${deviceInstalls.currentUpdateId} = ${deviceInstalls.embeddedUpdateId} THEN 'embedded'
    ELSE 'downloaded' END`;
  const rows = await db
    .select({
      channelName: deviceInstalls.channelName,
      platform: deviceInstalls.platform,
      runtimeVersion: deviceInstalls.runtimeVersion,
      sourceRevision,
      updateId: deviceInstalls.currentUpdateId,
      launchKind,
      installs: sql<number>`count(*)`,
    })
    .from(deviceInstalls)
    .leftJoin(releaseVariants, eq(releaseVariants.updateId, deviceInstalls.currentUpdateId))
    .leftJoin(
      releases,
      and(eq(releases.id, releaseVariants.releaseId), eq(releases.applicationId, applicationId)),
    )
    .where(and(...where))
    .groupBy(
      deviceInstalls.channelName,
      deviceInstalls.platform,
      deviceInstalls.runtimeVersion,
      sourceRevision,
      deviceInstalls.currentUpdateId,
      launchKind,
    )
    .orderBy(desc(sql`count(*)`));

  type Group = Pick<
    (typeof rows)[number],
    'channelName' | 'platform' | 'runtimeVersion' | 'sourceRevision'
  > & {
    installs: number;
    updates: {
      updateId: string | null;
      launchKind: DeviceInstall['launchKind'];
      installs: number;
    }[];
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.channelName,
      row.platform,
      row.runtimeVersion,
      row.sourceRevision,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        channelName: row.channelName,
        platform: row.platform,
        runtimeVersion: row.runtimeVersion,
        sourceRevision: row.sourceRevision,
        installs: 0,
        updates: [],
      };
      groups.set(key, group);
    }
    const installs = Number(row.installs);
    group.installs += installs;
    group.updates.push({ updateId: row.updateId, launchKind: row.launchKind, installs });
  }
  return { groups: [...groups.values()].sort((a, b) => b.installs - a.installs) };
}
