import type { DeviceMetrics } from '@ota/contracts';
import { Card, formatDate } from './ui.tsx';

export function DeviceMetricsPanel({ data }: { data: DeviceMetrics }) {
  const buckets = [
    ['Seen within 7 days', data.inactivity.within7d],
    ['Over 7 through 30 days', data.inactivity.over7Through30d],
    ['Over 30 through 60 days', data.inactivity.over30Through60d],
    ['Over 60 days', data.inactivity.over60d],
  ] as const;
  return (
    <>
      <Card>
        <h2 className="mb-3 font-medium">Active adoption</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Last OTA observations as of {formatDate(data.calculatedAt)}. Only install identities
          count; embedded and unknown updates remain eligible. This measures adoption, not delivery
          limits.
        </p>
        {data.groups.length === 0 && <p>No installs or deployments match.</p>}
        <div className="space-y-3">
          {data.groups.map((group) => (
            <div key={JSON.stringify([group.channelName, group.platform, group.runtimeVersion])}>
              <p className="text-sm font-medium">
                {group.channelName} · {group.platform} · runtime {group.runtimeVersion}
                {group.releaseNumber !== null && ` · #${group.releaseNumber}`}
              </p>
              <p className="text-sm">
                {group.deploymentState === 'rollback'
                  ? 'Rollback to embedded deployed'
                  : group.deploymentState === 'none'
                    ? 'No manifest deployment'
                    : group.adoptionPercent === null
                      ? 'No eligible installs'
                      : `${Number(group.adoptionPercent.toFixed(1))}% · ${group.activeOnTarget} of ${group.activeEligible} eligible installs seen in ${data.activeWithinDays} ${data.activeWithinDays === 1 ? 'day' : 'days'}`}
              </p>
              <p className="text-xs text-neutral-500">
                {group.unknownCurrentUpdate} active installs have not reported a current update ID.
              </p>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 font-medium">Time since last OTA check-in</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          {buckets.map(([label, count]) => (
            <div key={label}>
              <p className="text-xs text-neutral-500">{label}</p>
              <p className="text-2xl">{count}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Inactivity does not establish an uninstall or lack of app usage. These buckets include all
          retained installs matching channel, platform, and runtime, regardless of the adoption
          activity window.{' '}
          {data.retentionDays === 0
            ? 'Automatic age-based retention is disabled.'
            : `Configured retention: ${data.retentionDays} days; pruning removes older observations.`}{' '}
          {data.userFallbackRecords} user-ID fallback records are excluded from install metrics.
        </p>
      </Card>
    </>
  );
}
