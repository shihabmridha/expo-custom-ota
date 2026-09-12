import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { DeviceMetricsPanel } from '../components/DeviceMetrics.tsx';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  formatDate,
  Input,
  PageHeader,
  Select,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

const PAGE_SIZE = 25;

/** A client id is a UUID; the head is enough to tell installs apart by eye. */
function shortId(value: string): string {
  return value.startsWith('user:') ? value : value.slice(0, 8);
}

/**
 * "Apple iPhone15,2 · 17.5.1", or whichever parts the app chose to send. All
 * three are optional extra params, so any subset — or none — is normal.
 */
function deviceLabel(row: {
  deviceBrand: string | null;
  deviceModel: string | null;
  osVersion: string | null;
}): string {
  const hardware = [row.deviceBrand, row.deviceModel].filter(Boolean).join(' ');
  return [hardware, row.osVersion].filter(Boolean).join(' · ') || '—';
}

export function DevicesPage() {
  const { id } = useParams<{ id: string }>();

  const [channel, setChannel] = useState('');
  const [activeWithinDays, setActiveWithinDays] = useState(7);
  const [recipientOffset, setRecipientOffset] = useState(0);
  const [platform, setPlatform] = useState('');
  const [runtimeVersion, setRuntimeVersion] = useState('');
  const [userId, setUserId] = useState('');
  const [osVersion, setOsVersion] = useState('');
  const [deviceBrand, setDeviceBrand] = useState('');
  const [selectedUpdate, setSelectedUpdate] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const metricFilters = {
    activeWithinDays,
    ...(channel ? { channel } : {}),
    ...(platform ? { platform: platform as 'ios' | 'android' } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };
  const metrics = useQuery({
    queryKey: qk.deviceMetrics(id!, metricFilters),
    queryFn: () => api.devices.metrics({ params: { id: id! }, query: metricFilters }),
  });
  const filters = {
    ...metricFilters,
    limit: PAGE_SIZE,
    offset,
    ...(platform ? { platform: platform as 'ios' | 'android' } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(userId ? { userId } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceBrand ? { deviceBrand } : {}),
  };

  const adoption = useQuery({
    queryKey: qk.deviceAdoption(id!),
    queryFn: () => api.devices.adoption({ params: { id: id! } }),
  });
  const sourceGroups = useQuery({
    queryKey: ['device-source-groups', id, metricFilters],
    queryFn: () => api.devices.sourceGroups({ params: { id: id! }, query: metricFilters }),
  });
  const devices = useQuery({
    queryKey: qk.devices(id!, filters),
    queryFn: () => api.devices.list({ params: { id: id! }, query: filters }),
  });
  const recipients = useQuery({
    queryKey: qk.deviceRecipients(id!, selectedUpdate ?? '', recipientOffset),
    queryFn: () =>
      api.devices.recipients({
        params: { id: id!, updateId: selectedUpdate! },
        query: { kind: 'any', limit: PAGE_SIZE, offset: recipientOffset },
      }),
    enabled: selectedUpdate !== null,
  });

  if (metrics.data && !metrics.data.trackingEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Devices" />
        <EmptyState
          title="Device tracking is off"
          hint="Set DEVICE_TRACKING_ENABLED=true to record which installs receive each update. Nothing is stored while it is off."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Devices" />
      <Card>
        <h2 className="mb-3 font-medium">Metric and install filters</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Channel (exact)">
            <Input
              value={channel}
              placeholder="any"
              onChange={(e) => {
                setChannel(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Platform">
            <Select
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">any</option>
              <option value="ios">ios</option>
              <option value="android">android</option>
            </Select>
          </Field>
          <Field label="Runtime (exact)">
            <Input
              value={runtimeVersion}
              placeholder="any"
              onChange={(e) => {
                setRuntimeVersion(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Adoption and list activity window">
            <Select
              value={activeWithinDays}
              onChange={(e) => {
                setActiveWithinDays(Number(e.target.value));
                setOffset(0);
              }}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </Select>
          </Field>
        </div>
      </Card>
      {metrics.isPending && <p>Loading metrics…</p>}
      {metrics.isError && (
        <p role="alert">
          Could not load metrics.{' '}
          <button type="button" onClick={() => void metrics.refetch()}>
            Retry
          </button>
        </p>
      )}
      {metrics.data && !metrics.isError && <DeviceMetricsPanel data={metrics.data} />}

      <Card>
        <h2 className="mb-1 font-medium">Source releases</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Installs seen within the selected activity window, grouped by source revision, channel,
          platform and runtime. User-ID fallback records are excluded. A shared source revision does
          not imply identical bundle bytes.
        </p>
        {sourceGroups.isPending && <p>Loading source releases…</p>}
        {sourceGroups.isError && (
          <p role="alert">
            Could not load source releases.{' '}
            <button type="button" onClick={() => void sourceGroups.refetch()}>
              Retry
            </button>
          </p>
        )}
        {sourceGroups.data?.groups.length === 0 && (
          <p className="text-sm text-neutral-500">No installs match.</p>
        )}
        {sourceGroups.data?.groups.map((group) => (
          <details
            key={JSON.stringify([
              group.channelName,
              group.platform,
              group.runtimeVersion,
              group.sourceRevision,
            ])}
            className="border-t border-neutral-200 py-3 dark:border-neutral-800"
          >
            <summary className="cursor-pointer text-sm">
              <span className="break-all font-mono">
                {group.sourceRevision ?? 'Unknown source revision'}
              </span>
              <span className="ml-2 text-neutral-500">
                {group.channelName} · {group.platform} · runtime {group.runtimeVersion} ·{' '}
                {group.installs} {group.installs === 1 ? 'install' : 'installs'}
              </span>
            </summary>
            <ul className="mt-2 space-y-2 text-xs">
              {group.updates.map((update) => (
                <li key={`${update.updateId ?? 'unknown'}-${update.launchKind}`}>
                  <span className="break-all font-mono">
                    {update.updateId ?? 'Unknown update ID'}
                  </span>
                  {' · '}
                  {update.launchKind}
                  {' · '}
                  {update.installs} {update.installs === 1 ? 'install' : 'installs'}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </Card>

      <Card>
        <h2 className="mb-1 font-medium">Update history · all channels and activity periods</h2>
        <p className="mb-3 text-xs text-neutral-500">
          <strong>Served</strong> means we handed the install a manifest. <strong>Confirmed</strong>{' '}
          means it later reported running that update. The gap is served without observed
          confirmation, not proof of a failed download or launch. Counts spanning a retention
          boundary are not comparable, since pruned events disappear from both halves.
        </p>

        {adoption.isPending && <p>Loading update history…</p>}
        {adoption.isError && (
          <p role="alert">
            Could not load update history.{' '}
            <button type="button" onClick={() => void adoption.refetch()}>
              Retry
            </button>
          </p>
        )}
        {adoption.data?.byUpdate.length === 0 && (
          <p className="text-sm text-neutral-500">No installs have checked in yet.</p>
        )}

        {(adoption.data?.byUpdate.length ?? 0) > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="pb-2 font-normal">Update</th>
                <th className="pb-2 font-normal">Release</th>
                <th className="pb-2 font-normal">Runtime</th>
                <th className="pb-2 font-normal">Last observed running</th>
                <th className="pb-2 font-normal">Served</th>
                <th className="pb-2 font-normal">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {adoption.data?.byUpdate.map((row) => (
                <tr
                  key={row.updateId}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2">
                    <button
                      type="button"
                      className="font-mono text-xs underline decoration-dotted"
                      onClick={() => {
                        setSelectedUpdate(selectedUpdate === row.updateId ? null : row.updateId);
                        setRecipientOffset(0);
                      }}
                    >
                      {shortId(row.updateId)}
                    </button>
                  </td>
                  <td className="py-2">
                    {row.releaseNumber === null ? (
                      <span className="text-xs text-neutral-400">embedded / unknown</span>
                    ) : (
                      <span className="font-mono">#{row.releaseNumber}</span>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs">{row.runtimeVersion ?? '—'}</td>
                  <td className="py-2">{row.running}</td>
                  <td className="py-2">{row.served}</td>
                  <td className="py-2">{row.confirmed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selectedUpdate && (
        <Card>
          <h2 className="mb-3 font-medium">
            Received <span className="font-mono text-sm">{shortId(selectedUpdate)}</span>
          </h2>
          {recipients.isPending && <p>Loading recipients…</p>}
          {recipients.isError && (
            <p role="alert">
              Could not load recipients.{' '}
              <button type="button" onClick={() => void recipients.refetch()}>
                Retry
              </button>
            </p>
          )}
          {recipients.data?.items.length === 0 && (
            <p className="text-sm text-neutral-500">No install has received this update.</p>
          )}
          {(recipients.data?.items.length ?? 0) > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="pb-2 font-normal">Install</th>
                  <th className="pb-2 font-normal">User</th>
                  <th className="pb-2 font-normal">Device</th>
                  <th className="pb-2 font-normal">Served</th>
                  <th className="pb-2 font-normal">Confirmed</th>
                  <th className="pb-2 font-normal">Last observed running</th>
                </tr>
              </thead>
              <tbody>
                {recipients.data?.items.map((row) => (
                  <tr
                    key={row.clientId}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-2 font-mono text-xs">{shortId(row.clientId)}</td>
                    <td className="py-2">{row.userId ?? '—'}</td>
                    <td className="py-2 text-xs">{deviceLabel(row)}</td>
                    <td className="py-2 text-xs text-neutral-500">
                      {row.servedAt ? formatDate(row.servedAt) : '—'}
                    </td>
                    <td className="py-2 text-xs text-neutral-500">
                      {row.confirmedAt ? formatDate(row.confirmedAt) : '—'}
                    </td>
                    <td className="py-2">
                      {row.lastSeenAt
                        ? `${row.stillRunning ? 'yes' : 'no'} · ${formatDate(row.lastSeenAt)}`
                        : 'unknown (record pruned)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {recipients.data && (
            <div className="mt-3 flex gap-3 text-sm">
              <button
                type="button"
                disabled={recipientOffset === 0}
                onClick={() => setRecipientOffset(Math.max(0, recipientOffset - PAGE_SIZE))}
              >
                Previous
              </button>
              <span>
                {recipients.data.total === 0 ? 0 : recipientOffset + 1}–
                {Math.min(recipientOffset + PAGE_SIZE, recipients.data.total)} of{' '}
                {recipients.data.total}
              </span>
              <button
                type="button"
                disabled={recipientOffset + PAGE_SIZE >= recipients.data.total}
                onClick={() => setRecipientOffset(recipientOffset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="font-medium">Install records</h2>
        <p className="text-xs text-neutral-500">
          User and device filters below apply only to this list. User-ID fallback rows represent
          users, not individual installs.
        </p>
        {/* Every text filter is an exact match; the labels say so because a
            partial id otherwise looks like "no installs". */}
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="User id (exact)">
            <Input
              value={userId}
              placeholder="any"
              onChange={(e) => {
                setUserId(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Brand (exact)">
            <Input
              value={deviceBrand}
              placeholder="any"
              onChange={(e) => {
                setDeviceBrand(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="OS version (exact)">
            <Input
              value={osVersion}
              placeholder="any"
              onChange={(e) => {
                setOsVersion(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
        </div>

        {devices.isPending && <p>Loading install records…</p>}
        {devices.isError && (
          <p role="alert">
            Could not load install records.{' '}
            <button type="button" onClick={() => void devices.refetch()}>
              Retry
            </button>
          </p>
        )}
        {devices.data?.items.length === 0 && (
          <p className="text-sm text-neutral-500">No installs match.</p>
        )}

        {(devices.data?.items.length ?? 0) > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="pb-2 font-normal">Install</th>
                <th className="pb-2 font-normal">Keyed by</th>
                <th className="pb-2 font-normal">User</th>
                <th className="pb-2 font-normal">Platform</th>
                <th className="pb-2 font-normal">Device</th>
                <th className="pb-2 font-normal">Channel</th>
                <th className="pb-2 font-normal">Runtime</th>
                <th className="pb-2 font-normal">Last observed running</th>
                <th className="pb-2 font-normal">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.data?.items.map((row) => (
                <tr
                  key={row.clientId}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2 font-mono text-xs">{shortId(row.clientId)}</td>
                  <td className="py-2">
                    {/* A `user` row is one person, not one install — their
                        devices collapse together, so the source has to show. */}
                    <Badge value={row.clientIdSource} />
                  </td>
                  <td className="py-2">{row.userId ?? '—'}</td>
                  <td className="py-2">{row.platform}</td>
                  <td className="py-2 text-xs">{deviceLabel(row)}</td>
                  <td className="py-2">{row.channelName}</td>
                  <td className="py-2 font-mono text-xs">{row.runtimeVersion}</td>
                  <td className="py-2">
                    {row.currentReleaseNumber !== null ? (
                      <span className="font-mono">#{row.currentReleaseNumber}</span>
                    ) : row.currentUpdateId ? (
                      <span className="text-xs text-neutral-400">
                        {row.launchKind === 'embedded'
                          ? 'Embedded build'
                          : row.launchKind === 'downloaded'
                            ? 'Downloaded update'
                            : 'Unknown update'}
                      </span>
                    ) : (
                      '—'
                    )}
                    <div className="max-w-xs break-all text-xs text-neutral-500">
                      {row.sourceRevision ?? 'Unknown source revision'} · {row.launchKind}
                    </div>
                    <div className="max-w-xs break-all font-mono text-xs">
                      {row.currentUpdateId}
                    </div>
                  </td>
                  <td className="py-2 text-xs text-neutral-500">{formatDate(row.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(devices.data?.total ?? 0) > PAGE_SIZE && (
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-40"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <span className="text-xs text-neutral-500">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, devices.data?.total ?? 0)} of{' '}
              {devices.data?.total}
            </span>
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-40"
              disabled={offset + PAGE_SIZE >= (devices.data?.total ?? 0)}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
