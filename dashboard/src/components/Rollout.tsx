import type { DeviceMetrics } from '@ota/contracts';
import { useState } from 'react';
import {
  CompositionBar,
  formatCount,
  formatPercent,
  Meter,
  RolloutChart,
  type RolloutPoint,
  type Segment,
} from './charts.tsx';
import { timeAgo } from './ui.tsx';

type Group = DeviceMetrics['groups'][number];

export const groupKey = (g: Pick<Group, 'channelName' | 'platform' | 'runtimeVersion'>) =>
  `${g.channelName}\u0000${g.platform}\u0000${g.runtimeVersion}`;

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;

/** Below this many sends a launch rate is noise, not a signal. */
const LAUNCH_RATE_MIN_SAMPLE = 20;
const LAUNCH_RATE_WARN = 0.8;
/** The rollout curve shows at most this many trailing days. */
const CURVE_DAYS = 90;

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Turn per-day first-time events into cumulative points, one per UTC day from
 * the first event (or the deployment, whichever came first) through today.
 * Days without events carry the running total forward, so the line is honest
 * about quiet periods instead of interpolating across them.
 */
export function cumulativeRollout(group: Group, today: Date): RolloutPoint[] {
  const firstEvent = group.timeline[0]?.day;
  const deployed = group.deployedAt ? utcDay(new Date(group.deployedAt)) : undefined;
  const start = [firstEvent, deployed].filter(Boolean).sort()[0];
  if (!start) return [];

  const byDay = new Map(group.timeline.map((d) => [d.day, d]));
  const points: RolloutPoint[] = [];
  let sent = 0;
  let launched = 0;
  const end = utcDay(today);
  for (let cursor = new Date(`${start}T00:00:00Z`); ; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = utcDay(cursor);
    if (day > end) break;
    sent += byDay.get(day)?.served ?? 0;
    launched += byDay.get(day)?.confirmed ?? 0;
    points.push({ day, sent, launched });
  }
  return points.slice(-CURVE_DAYS);
}

/** Fold what the cohort runs into the four states a release engineer acts on. */
export function runningSegments(group: Group): Segment[] {
  const target = group.deploymentState === 'update' ? group.updateId : null;
  let latest = 0;
  let embedded = 0;
  let unreported = 0;
  const older = new Map<string, number>();

  for (const row of group.running) {
    if (target && row.updateId === target) latest += row.installs;
    else if (row.launchKind === 'embedded') embedded += row.installs;
    else if (row.updateId === null) unreported += row.installs;
    else {
      const label = row.releaseNumber === null ? 'unrecognized' : `#${row.releaseNumber}`;
      older.set(label, (older.get(label) ?? 0) + row.installs);
    }
  }

  const olderTotal = [...older.values()].reduce((a, b) => a + b, 0);
  const segments: Segment[] = [];
  if (target) {
    segments.push({
      key: 'latest',
      label: group.releaseNumber === null ? 'Deployed update' : `Release #${group.releaseNumber}`,
      value: latest,
      color: 'var(--viz-latest)',
    });
  }
  segments.push(
    {
      key: 'older',
      label: target ? 'Older updates' : 'Downloaded updates',
      value: olderTotal,
      color: 'var(--viz-older)',
      detail:
        older.size > 0
          ? [...older.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([label, n]) => `${label} (${formatCount(n)})`)
              .join(', ')
          : undefined,
    },
    {
      key: 'embedded',
      label: 'Embedded build',
      value: embedded,
      color: 'var(--viz-embedded)',
      detail: embedded > 0 ? 'Running the bundle shipped in the store binary' : undefined,
    },
    {
      key: 'unreported',
      label: 'Not reported',
      value: unreported,
      color: 'var(--viz-unknown)',
      hatched: true,
      detail: unreported > 0 ? 'Checked in without a current update id' : undefined,
    },
  );
  return segments;
}

function windowLabel(days: number) {
  return days === 1 ? 'the last 24 hours' : `the last ${days} days`;
}

function TargetName({ group }: { group: Group }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium">{group.channelName}</span>
      <span className="block text-xs text-neutral-500">
        {PLATFORM_LABEL[group.platform]}, runtime{' '}
        <span className="font-mono">{group.runtimeVersion}</span>
      </span>
    </span>
  );
}

function targetSummary(group: Group): string {
  if (group.deploymentState === 'rollback') return 'Rollback';
  if (group.deploymentState === 'none') return 'Not deployed';
  if (group.adoptionPercent === null) return 'No installs';
  return formatPercent(group.adoptionPercent / 100);
}

/**
 * The page's headline: for each deployment target, how much of its active
 * install base runs the deployed release, how delivery is going, and what
 * everyone else is still on.
 */
export function RolloutPanel({ data }: { data: DeviceMetrics }) {
  // Targets with a live update first, then by audience size.
  const groups = [...data.groups].sort(
    (a, b) =>
      Number(b.deploymentState === 'update') - Number(a.deploymentState === 'update') ||
      b.activeEligible - a.activeEligible,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = groups.find((g) => groupKey(g) === selectedKey) ?? groups[0];

  if (!selected) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
        <p className="font-medium">No installs or deployments match these filters</p>
        <p className="mt-1 text-sm text-neutral-500">
          Installs appear here after their first update check against this server.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="rollout-heading"
      className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {groups.length > 1 && (
          <nav
            aria-label="Deployment targets"
            className="min-w-0 border-b border-neutral-200 bg-neutral-50/60 p-2 lg:border-r lg:border-b-0 dark:border-neutral-800 dark:bg-neutral-950/40"
          >
            <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
              {groups.map((group) => {
                const isSelected = groupKey(group) === groupKey(selected);
                return (
                  <li key={groupKey(group)} className="min-w-52 lg:min-w-0">
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => setSelectedKey(groupKey(group))}
                      className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-900 dark:focus-visible:outline-white ${
                        isSelected
                          ? 'bg-white shadow-[0_0_0_1px] shadow-neutral-200 dark:bg-neutral-900 dark:shadow-neutral-700'
                          : 'hover:bg-white/70 dark:hover:bg-neutral-900/60'
                      }`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <TargetName group={group} />
                        <span
                          className={`shrink-0 text-sm tabular-nums ${
                            group.deploymentState === 'rollback'
                              ? 'text-red-700 dark:text-red-300'
                              : 'text-neutral-700 dark:text-neutral-300'
                          }`}
                        >
                          {targetSummary(group)}
                        </span>
                      </span>
                      {group.deploymentState === 'update' && (
                        <span className="mt-2 block">
                          <Meter
                            fraction={
                              group.adoptionPercent === null ? null : group.adoptionPercent / 100
                            }
                          />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        <TargetDetail
          group={selected}
          activeWithinDays={data.activeWithinDays}
          calculatedAt={new Date(data.calculatedAt)}
          showName={groups.length <= 1}
        />
      </div>
    </section>
  );
}

function TargetDetail({
  group,
  activeWithinDays,
  calculatedAt,
  showName,
}: {
  group: Group;
  activeWithinDays: number;
  calculatedAt: Date;
  showName: boolean;
}) {
  const points = cumulativeRollout(group, calculatedAt);
  const launchRate = group.served > 0 ? group.confirmed / group.served : null;
  const lowLaunchRate =
    launchRate !== null && group.served >= LAUNCH_RATE_MIN_SAMPLE && launchRate < LAUNCH_RATE_WARN;

  return (
    <div className="min-w-0 space-y-6 p-5 sm:p-6">
      {showName && (
        <div className="text-sm">
          <TargetName group={group} />
        </div>
      )}

      {group.deploymentState === 'update' && (
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div>
            <h2 id="rollout-heading" className="text-sm text-neutral-600 dark:text-neutral-400">
              Adoption of{' '}
              {group.releaseNumber === null
                ? 'the deployed update'
                : `release #${group.releaseNumber}`}
            </h2>
            <p className="mt-1 text-6xl font-semibold tracking-tight tabular-nums">
              {group.adoptionPercent === null ? '—' : formatPercent(group.adoptionPercent / 100)}
            </p>
            <p className="mt-2 max-w-md text-sm text-neutral-600 dark:text-neutral-400">
              {group.activeEligible === 0
                ? `No installs on this target checked in during ${windowLabel(activeWithinDays)}.`
                : `${formatCount(group.activeOnTarget)} of ${formatCount(group.activeEligible)} installs active in ${windowLabel(activeWithinDays)} run it.`}
              {group.deployedAt && ` Deployed ${timeAgo(group.deployedAt, calculatedAt)}.`}
            </p>
          </div>
          <dl className="flex gap-x-8 text-sm">
            {(
              [
                ['Sent', formatCount(group.served)],
                ['Launched', formatCount(group.confirmed)],
                ['Launch rate', launchRate === null ? '—' : formatPercent(launchRate)],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {group.deploymentState === 'rollback' && (
        <div
          role="status"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
        >
          <h2 id="rollout-heading" className="font-medium">
            Rollback to embedded is live
          </h2>
          <p className="mt-1">
            Installs on this target are told to discard downloaded updates and run the bundle in
            their binary. They move to "Embedded build" below as they check in.
          </p>
        </div>
      )}

      {group.deploymentState === 'none' && (
        <div>
          <h2 id="rollout-heading" className="font-medium">
            Nothing is deployed to this target
          </h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            These installs check in, but every check answers "no update available". Publish a
            release to {group.channelName} for runtime {group.runtimeVersion} to reach them.
          </p>
        </div>
      )}

      {lowLaunchRate && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span aria-hidden className="font-semibold">
            !
          </span>
          <p>
            <span className="font-medium">Fewer launches than sends.</span>{' '}
            {formatCount(group.served - group.confirmed)} installs received this update but have not
            reported running it. Expo applies updates on the next cold start, so some lag is normal;
            a gap that keeps growing points at failed downloads, a signing mismatch, or a crash on
            launch. Check the Simulator tab for this target.
          </p>
        </div>
      )}

      {group.deploymentState === 'update' && (
        <div>
          <h3 className="mb-1 text-sm font-medium">Rollout over time</h3>
          <p className="mb-3 text-xs text-neutral-500">
            Cumulative installs, counting each install once. Counts cover every channel this update
            is deployed to.
          </p>
          {points.length === 0 ? (
            <p className="text-sm text-neutral-500">No install has been sent this update yet.</p>
          ) : (
            <RolloutChart
              points={points}
              reference={
                group.activeEligible > 0
                  ? {
                      value: group.activeEligible,
                      label: `${formatCount(group.activeEligible)} active installs`,
                    }
                  : null
              }
            />
          )}
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-medium">
          What active installs run now
          <span className="ml-2 font-normal text-neutral-500">
            {formatCount(group.activeEligible)} seen in {windowLabel(activeWithinDays)}
          </span>
        </h3>
        <CompositionBar segments={runningSegments(group)} />
      </div>
    </div>
  );
}
