import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
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

  const [platform, setPlatform] = useState('');
  const [runtimeVersion, setRuntimeVersion] = useState('');
  const [userId, setUserId] = useState('');
  const [osVersion, setOsVersion] = useState('');
  const [deviceBrand, setDeviceBrand] = useState('');
  const [selectedUpdate, setSelectedUpdate] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const filters = {
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
  const devices = useQuery({
    queryKey: qk.devices(id!, filters),
    queryFn: () => api.devices.list({ params: { id: id! }, query: filters }),
  });
  const recipients = useQuery({
    queryKey: qk.deviceRecipients(id!, selectedUpdate ?? ''),
    queryFn: () =>
      api.devices.recipients({
        params: { id: id!, updateId: selectedUpdate! },
        query: { kind: 'any', limit: PAGE_SIZE, offset: 0 },
      }),
    enabled: selectedUpdate !== null,
  });

  if (adoption.data && !adoption.data.trackingEnabled) {
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

  const totals = adoption.data?.totals;

  return (
    <div className="space-y-6">
      <PageHeader title="Devices" />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-neutral-500">Installs</p>
          <p className="text-2xl">{totals?.installs ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-xs text-neutral-500">Active last 24h</p>
          <p className="text-2xl">{totals?.activeLast24h ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-xs text-neutral-500">Active last 7d</p>
          <p className="text-2xl">{totals?.activeLast7d ?? '—'}</p>
        </Card>
      </div>

      <Card>
        <h2 className="mb-1 font-medium">Adoption</h2>
        <p className="mb-3 text-xs text-neutral-500">
          <strong>Served</strong> means we handed the install a manifest. <strong>Confirmed</strong>{' '}
          means it later reported actually running that update — the gap is downloads that never
          launched. Counts spanning a retention boundary are not comparable, since pruned events
          disappear from both halves.
        </p>

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
                <th className="pb-2 font-normal">Running</th>
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
                      onClick={() =>
                        setSelectedUpdate(selectedUpdate === row.updateId ? null : row.updateId)
                      }
                    >
                      {shortId(row.updateId)}
                    </button>
                  </td>
                  <td className="py-2">
                    {row.releaseNumber === null ? (
                      // An update id we never issued — an embedded bundle.
                      <span className="text-xs text-neutral-400">embedded</span>
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
                  <th className="pb-2 font-normal">Still running</th>
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
                    <td className="py-2">{row.stillRunning ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="font-medium">Installs</h2>
        {/* Every text filter is an exact match; the labels say so because a
            partial id otherwise looks like "no installs". */}
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Platform">
            <Select
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">any</option>
              <option value="android">android</option>
              <option value="ios">ios</option>
            </Select>
          </Field>
          <Field label="Runtime version (exact)">
            <Input
              value={runtimeVersion}
              placeholder="any"
              onChange={(e) => {
                setRuntimeVersion(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
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
                <th className="pb-2 font-normal">Running</th>
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
                      <span className="text-xs text-neutral-400">embedded</span>
                    ) : (
                      '—'
                    )}
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
