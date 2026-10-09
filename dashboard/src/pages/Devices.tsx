import type { DeviceAdoption, DeviceInstall, DeviceMetrics } from '@ota/contracts';
import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode, useState } from 'react';
import { useParams } from 'react-router';
import {
  DailyColumns,
  formatCount,
  formatPercent,
  LabelledBars,
  Meter,
} from '../components/charts.tsx';
import { RolloutPanel } from '../components/Rollout.tsx';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  formatDate,
  Input,
  PageHeader,
  Segmented,
  Select,
  timeAgo,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

const PAGE_SIZE = 25;
const CHECK_DAYS = 30;

type Platform = 'ios' | 'android';
type ActiveWindow = 1 | 7 | 30;

const PLATFORM_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
] as const;
const WINDOW_OPTIONS = [
  { value: 1, label: '24 hours' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
] as const;

/** A client id is a UUID; the head is enough to tell installs apart by eye. */
function shortId(value: string): string {
  return value.startsWith('user:') ? value : value.slice(0, 8);
}

/** "Apple iPhone15,2, iOS 17.5.1", or whichever parts the app chose to send. */
function deviceLabel(row: {
  deviceBrand: string | null;
  deviceModel: string | null;
  osVersion: string | null;
}): string {
  const hardware = [row.deviceBrand, row.deviceModel].filter(Boolean).join(' ');
  return [hardware, row.osVersion].filter(Boolean).join(', ') || '—';
}

function Retry({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p role="alert" className="text-sm text-red-700 dark:text-red-300">
      Could not load {what}.{' '}
      <button type="button" className="underline" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-medium">{title}</h2>
          {description && (
            <p className="mt-0.5 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
              {description}
            </p>
          )}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function DevicesPage() {
  const { id } = useParams<{ id: string }>();

  const [channel, setChannel] = useState('');
  const [platform, setPlatform] = useState<'' | Platform>('');
  const [runtimeVersion, setRuntimeVersion] = useState('');
  const [activeWithinDays, setActiveWithinDays] = useState<ActiveWindow>(7);

  const cohort = {
    activeWithinDays,
    ...(channel ? { channel } : {}),
    ...(platform ? { platform } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };

  const metrics = useQuery({
    queryKey: qk.deviceMetrics(id!, cohort),
    queryFn: () => api.devices.metrics({ params: { id: id! }, query: cohort }),
    // Keep the previous answer on screen while a filter change loads.
    placeholderData: (previous) => previous,
  });
  const channels = useQuery({
    queryKey: qk.channels(id!),
    queryFn: () => api.channels.list({ params: { id: id! } }),
  });
  const deployments = useQuery({
    queryKey: qk.deployments(id!),
    queryFn: () => api.deployments.list({ params: { id: id! } }),
  });

  if (metrics.data && !metrics.data.trackingEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Devices" />
        <EmptyState
          title="Device tracking is off"
          hint="Set DEVICE_TRACKING_ENABLED=true to see how updates reach installs. Nothing is recorded while it is off."
        />
      </div>
    );
  }

  const runtimes = [
    ...new Set([
      ...(deployments.data ?? []).map((d) => d.runtimeVersion),
      ...(metrics.data?.groups ?? []).map((g) => g.runtimeVersion),
      ...(runtimeVersion ? [runtimeVersion] : []),
    ]),
  ].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Devices"
        description="How your deployed updates are reaching installed apps."
      />

      <div className="-mt-4 flex flex-wrap items-end gap-x-5 gap-y-3">
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {channels.data?.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Segmented
          label="Platform"
          value={platform}
          options={PLATFORM_OPTIONS}
          onChange={setPlatform}
        />
        <Field label="Runtime">
          <Select value={runtimeVersion} onChange={(e) => setRuntimeVersion(e.target.value)}>
            <option value="">All runtimes</option>
            {runtimes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Segmented
          label="Active within"
          value={activeWithinDays}
          options={WINDOW_OPTIONS}
          onChange={setActiveWithinDays}
        />
      </div>

      {metrics.isPending && <p className="text-sm text-neutral-500">Loading rollouts…</p>}
      {metrics.isError && <Retry what="device metrics" onRetry={() => void metrics.refetch()} />}
      {metrics.data && (
        <div className={metrics.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          <RolloutPanel data={metrics.data} />
        </div>
      )}

      {metrics.data && (
        <Activity
          applicationId={id!}
          data={metrics.data}
          platform={platform}
          channelFiltered={Boolean(channel)}
        />
      )}

      <UpdateHistory applicationId={id!} platform={platform} runtimeVersion={runtimeVersion} />

      <InstallLookup applicationId={id!} cohort={cohort} />

      {metrics.data && <Methodology data={metrics.data} />}
    </div>
  );
}

// --- Activity ----------------------------------------------------------------

const CHECK_SERIES = [
  { key: 'update_served', label: 'Sent an update', color: 'var(--viz-latest)' },
  { key: 'no_update_available', label: 'Already up to date', color: 'var(--viz-baseline)' },
  { key: 'roll_back_to_embedded', label: 'Told to roll back', color: 'var(--viz-rollback)' },
];

function Activity({
  applicationId,
  data,
  platform,
  channelFiltered,
}: {
  applicationId: string;
  data: DeviceMetrics;
  platform: '' | Platform;
  channelFiltered: boolean;
}) {
  const usage = useQuery({
    queryKey: qk.metrics(applicationId),
    queryFn: () => api.applications.metrics({ params: { id: applicationId } }),
  });

  // Fill every day of the window so quiet days read as zero, not as a gap.
  const end = new Date(data.calculatedAt);
  const days = Array.from({ length: CHECK_DAYS }, (_, i) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (CHECK_DAYS - 1 - i));
    return { day: date.toISOString().slice(0, 10), values: {} as Record<string, number> };
  });
  const byDay = new Map(days.map((d) => [d.day, d.values]));
  for (const row of usage.data?.daily ?? []) {
    if (platform && row.platform !== platform) continue;
    const values = byDay.get(row.day);
    if (values) values[row.result] = (values[row.result] ?? 0) + row.count;
  }
  const totalChecks = days.reduce(
    (sum, d) => sum + Object.values(d.values).reduce((a, b) => a + b, 0),
    0,
  );

  const { activeInstalls, inactivity } = data;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Card className="space-y-5">
        <div>
          <h2 className="font-medium">Active installs</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            {(
              [
                ['24 hours', activeInstalls.last1d],
                ['7 days', activeInstalls.last7d],
                ['30 days', activeInstalls.last30d],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{formatCount(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-medium">Last update check</h3>
          <LabelledBars
            rows={[
              { label: 'Within 7 days', value: inactivity.within7d },
              { label: '8 to 30 days ago', value: inactivity.over7Through30d },
              { label: '31 to 60 days ago', value: inactivity.over30Through60d },
              { label: 'Over 60 days ago', value: inactivity.over60d },
            ]}
          />
          <p className="mt-3 text-xs text-neutral-500">
            Silence is not an uninstall: an app only checks when it starts.
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="font-medium">Update checks per day</h2>
        <p className="mt-0.5 mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          {formatCount(totalChecks)} checks in the last {CHECK_DAYS} days
          {channelFiltered ? ', across all channels' : ''}. Every app launch is one check.
        </p>
        {usage.isError ? (
          <Retry what="update checks" onRetry={() => void usage.refetch()} />
        ) : (
          <DailyColumns days={days} series={CHECK_SERIES} />
        )}
      </Card>
    </div>
  );
}

// --- Update history ----------------------------------------------------------

function UpdateHistory({
  applicationId,
  platform,
  runtimeVersion,
}: {
  applicationId: string;
  platform: '' | Platform;
  runtimeVersion: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const adoption = useQuery({
    queryKey: qk.deviceAdoption(applicationId),
    queryFn: () => api.devices.adoption({ params: { id: applicationId } }),
  });

  // The history is application-wide; platform and runtime narrow it client-side.
  const rows = (adoption.data?.byUpdate ?? []).filter(
    (row) =>
      (!platform || row.platform === null || row.platform === platform) &&
      (!runtimeVersion || row.runtimeVersion === runtimeVersion),
  );

  return (
    <Section
      title="Every update"
      description="Each update installs have been sent or are running, newest release first. Select one to see which installs received it."
    >
      <Card className="overflow-x-auto p-0">
        {adoption.isPending && <p className="p-4 text-sm text-neutral-500">Loading updates…</p>}
        {adoption.isError && (
          <div className="p-4">
            <Retry what="update history" onRetry={() => void adoption.refetch()} />
          </div>
        )}
        {adoption.data && rows.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">No installs have checked in yet.</p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-neutral-600 dark:text-neutral-400">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="px-4 py-2.5 font-medium">Update</th>
                <th className="px-4 py-2.5 font-medium">Platform</th>
                <th className="px-4 py-2.5 font-medium">Runtime</th>
                <th className="px-4 py-2.5 text-right font-medium">Running now</th>
                <th className="px-4 py-2.5 text-right font-medium">Sent</th>
                <th className="px-4 py-2.5 text-right font-medium">Launched</th>
                <th className="w-40 px-4 py-2.5 font-medium">Launch rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.updateId}>
                  <HistoryRow
                    row={row}
                    expanded={selected === row.updateId}
                    onToggle={() => setSelected(selected === row.updateId ? null : row.updateId)}
                  />
                  {selected === row.updateId && (
                    <tr>
                      <td colSpan={7} className="bg-neutral-50 px-4 py-4 dark:bg-neutral-950/50">
                        <Recipients applicationId={applicationId} updateId={row.updateId} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Section>
  );
}

function HistoryRow({
  row,
  expanded,
  onToggle,
}: {
  row: DeviceAdoption['byUpdate'][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const rate = row.served > 0 ? row.confirmed / row.served : null;
  return (
    <tr className="border-t border-neutral-200 first:border-t-0 dark:border-neutral-800">
      <td className="px-4 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="group flex items-baseline gap-2 text-left focus-visible:outline-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-white"
        >
          <span
            aria-hidden
            className="text-neutral-400 transition-transform group-aria-expanded:rotate-90"
          >
            ›
          </span>
          {row.releaseNumber === null ? (
            <span>Embedded build</span>
          ) : (
            <span className="font-medium">Release #{row.releaseNumber}</span>
          )}
          <span className="font-mono text-xs text-neutral-500">{shortId(row.updateId)}</span>
        </button>
      </td>
      <td className="px-4 py-2.5">
        {row.platform === null ? '—' : row.platform === 'ios' ? 'iOS' : 'Android'}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">{row.runtimeVersion ?? '—'}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.running)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.served)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.confirmed)}</td>
      <td className="px-4 py-2.5">
        {rate === null ? (
          <span className="text-neutral-400">—</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="w-10 text-right tabular-nums">{formatPercent(rate)}</span>
            <Meter fraction={rate} />
          </span>
        )}
      </td>
    </tr>
  );
}

function Recipients({ applicationId, updateId }: { applicationId: string; updateId: string }) {
  const [offset, setOffset] = useState(0);
  const recipients = useQuery({
    queryKey: qk.deviceRecipients(applicationId, updateId, offset),
    queryFn: () =>
      api.devices.recipients({
        params: { id: applicationId, updateId },
        query: { kind: 'any', limit: PAGE_SIZE, offset },
      }),
    placeholderData: (previous) => previous,
  });

  if (recipients.isPending) return <p className="text-sm text-neutral-500">Loading installs…</p>;
  if (recipients.isError) {
    return <Retry what="installs" onRetry={() => void recipients.refetch()} />;
  }
  const data = recipients.data;
  if (data.items.length === 0) {
    return <p className="text-sm text-neutral-500">No install has been sent this update.</p>;
  }

  return (
    <div className="space-y-3">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-neutral-600 dark:text-neutral-400">
          <tr>
            <th className="pb-2 font-medium">Install</th>
            <th className="pb-2 font-medium">User</th>
            <th className="pb-2 font-medium">Device</th>
            <th className="pb-2 font-medium">Sent</th>
            <th className="pb-2 font-medium">Launched</th>
            <th className="pb-2 font-medium">Now</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((row) => (
            <tr key={row.clientId} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="py-2 font-mono text-xs">{shortId(row.clientId)}</td>
              <td className="py-2">{row.userId ?? '—'}</td>
              <td className="py-2 text-xs">{deviceLabel(row)}</td>
              <td className="py-2 text-xs text-neutral-600 dark:text-neutral-400">
                {row.servedAt ? (
                  <time title={formatDate(row.servedAt)}>{timeAgo(row.servedAt)}</time>
                ) : (
                  '—'
                )}
              </td>
              <td className="py-2 text-xs text-neutral-600 dark:text-neutral-400">
                {row.confirmedAt ? (
                  <time title={formatDate(row.confirmedAt)}>{timeAgo(row.confirmedAt)}</time>
                ) : (
                  'Not yet'
                )}
              </td>
              <td className="py-2 text-xs">
                {row.lastSeenAt === null
                  ? 'Record pruned'
                  : row.stillRunning
                    ? 'Still running it'
                    : 'Moved on'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager offset={offset} total={data.total} onChange={setOffset} />
    </div>
  );
}

// --- Install lookup ----------------------------------------------------------

function runningLabel(row: DeviceInstall): string {
  if (row.currentReleaseNumber !== null) return `Release #${row.currentReleaseNumber}`;
  if (row.launchKind === 'embedded') return 'Embedded build';
  if (row.currentUpdateId) return 'Unrecognized update';
  return 'Not reported';
}

function InstallLookup({
  applicationId,
  cohort,
}: {
  applicationId: string;
  cohort: {
    activeWithinDays: ActiveWindow;
    channel?: string;
    platform?: Platform;
    runtimeVersion?: string;
  };
}) {
  const [userId, setUserId] = useState('');
  const [deviceBrand, setDeviceBrand] = useState('');
  const [osVersion, setOsVersion] = useState('');
  const [offset, setOffset] = useState(0);

  const filters = {
    ...cohort,
    limit: PAGE_SIZE,
    offset,
    ...(userId ? { userId } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceBrand ? { deviceBrand } : {}),
  };
  const devices = useQuery({
    queryKey: qk.devices(applicationId, filters),
    queryFn: () => api.devices.list({ params: { id: applicationId }, query: filters }),
    placeholderData: (previous) => previous,
  });

  // Any filter change returns to the first page.
  const filterKey = JSON.stringify([cohort, userId, deviceBrand, osVersion]);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setOffset(0);
  }

  return (
    <Section
      title="Find an install"
      description="Installs active in the selected window, most recent first. These filters match exactly."
    >
      <Card className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="User id">
            <Input value={userId} placeholder="Any" onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <Field label="Device brand">
            <Input
              value={deviceBrand}
              placeholder="Any, e.g. Google"
              onChange={(e) => setDeviceBrand(e.target.value)}
            />
          </Field>
          <Field label="OS version">
            <Input
              value={osVersion}
              placeholder="Any, e.g. 17.5.1"
              onChange={(e) => setOsVersion(e.target.value)}
            />
          </Field>
        </div>

        {devices.isPending && <p className="text-sm text-neutral-500">Loading installs…</p>}
        {devices.isError && <Retry what="installs" onRetry={() => void devices.refetch()} />}
        {devices.data?.items.length === 0 && (
          <p className="text-sm text-neutral-500">No installs match.</p>
        )}

        {(devices.data?.items.length ?? 0) > 0 && (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-600 dark:text-neutral-400">
                <tr>
                  <th className="pb-2 font-medium">Install</th>
                  <th className="pb-2 font-medium">User</th>
                  <th className="pb-2 font-medium">Device</th>
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium">Running</th>
                  <th className="pb-2 font-medium">Last check</th>
                </tr>
              </thead>
              <tbody>
                {devices.data?.items.map((row) => (
                  <tr
                    key={row.clientId}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-2">
                      <span className="font-mono text-xs">{shortId(row.clientId)}</span>
                      {/* A `user` row is one person, not one install — their
                          devices collapse together, so the source has to show. */}
                      {row.clientIdSource === 'user' && (
                        <span className="ml-2">
                          <Badge value="per user" />
                        </span>
                      )}
                    </td>
                    <td className="py-2">{row.userId ?? '—'}</td>
                    <td className="py-2 text-xs">
                      {row.platform === 'ios' ? 'iOS' : 'Android'}
                      <span className="block text-neutral-500">{deviceLabel(row)}</span>
                    </td>
                    <td className="py-2 text-xs">
                      {row.channelName}
                      <span className="block font-mono text-neutral-500">{row.runtimeVersion}</span>
                    </td>
                    <td className="py-2 text-xs">
                      <span className="font-medium">{runningLabel(row)}</span>
                      {row.sourceRevision && (
                        <span
                          className="block max-w-56 truncate font-mono text-neutral-500"
                          title={row.sourceRevision}
                        >
                          {row.sourceRevision}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-neutral-600 dark:text-neutral-400">
                      <time title={formatDate(row.lastSeenAt)}>{timeAgo(row.lastSeenAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {devices.data && <Pager offset={offset} total={devices.data.total} onChange={setOffset} />}
      </Card>
    </Section>
  );
}

function Pager({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        className="underline disabled:no-underline disabled:opacity-40"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
      >
        Previous
      </button>
      <span className="text-xs text-neutral-500 tabular-nums">
        {formatCount(offset + 1)}–{formatCount(Math.min(offset + PAGE_SIZE, total))} of{' '}
        {formatCount(total)}
      </span>
      <button
        type="button"
        className="underline disabled:no-underline disabled:opacity-40"
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => onChange(offset + PAGE_SIZE)}
      >
        Next
      </button>
    </div>
  );
}

// --- Methodology -------------------------------------------------------------

function Methodology({ data }: { data: DeviceMetrics }) {
  return (
    <details className="rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
      <summary className="cursor-pointer font-medium">How these numbers work</summary>
      <dl className="mt-3 max-w-prose space-y-3 text-neutral-700 dark:text-neutral-300">
        <div>
          <dt className="font-medium">Adoption</dt>
          <dd>
            Installs on a target that checked in during the selected window and reported running the
            deployed update, divided by every install on that target that checked in during the
            window, including those on the embedded build or not reporting an update id.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Sent and launched</dt>
          <dd>
            Sent means the server handed the install this update. Launched means the install later
            reported running it. Each install counts once per update. The gap is installs that have
            not launched it yet, not proof of a failed download.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Who counts as an install</dt>
          <dd>
            Installs identified by the Expo client id or an app-supplied install id.
            {data.userFallbackRecords > 0 &&
              ` ${formatCount(data.userFallbackRecords)} records keyed only by user id stand for people rather than installs and are left out of these numbers; they still appear in Find an install.`}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Retention</dt>
          <dd>
            {data.retentionDays === 0
              ? 'Records are kept indefinitely.'
              : `Records older than ${data.retentionDays} days are pruned, which removes them from every count here. Totals that span a pruning boundary are not comparable.`}{' '}
            Calculated {formatDate(data.calculatedAt)}.
          </dd>
        </div>
      </dl>
    </details>
  );
}
