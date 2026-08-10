import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  formatDate,
  Input,
  PageHeader,
  Select,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function DeploymentsPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [channel, setChannel] = useState('production');
  const [platform, setPlatform] = useState<'ios' | 'android'>('android');
  const [runtimeVersion, setRuntimeVersion] = useState('');

  const deployments = useQuery({
    queryKey: qk.deployments(id!),
    queryFn: () => api.deployments.list({ params: { id: id! } }),
  });
  const events = useQuery({
    queryKey: qk.deploymentEvents(id!),
    queryFn: () => api.deployments.history({ params: { id: id! } }),
  });
  const channels = useQuery({
    queryKey: qk.channels(id!),
    queryFn: () => api.channels.list({ params: { id: id! } }),
  });

  const killSwitch = useMutation({
    mutationFn: () =>
      api.deployments.rollBackToEmbedded({
        params: { id: id! },
        body: { channel, platform, runtimeVersion },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.deployments(id!) });
      await queryClient.invalidateQueries({ queryKey: qk.deploymentEvents(id!) });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Deployments" />

      {deployments.data?.length === 0 && <EmptyState title="Nothing deployed" />}

      {(deployments.data?.length ?? 0) > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="pb-2 font-normal">Channel</th>
                <th className="pb-2 font-normal">Platform</th>
                <th className="pb-2 font-normal">Runtime</th>
                <th className="pb-2 font-normal">Serving</th>
                <th className="pb-2 font-normal">Updated</th>
              </tr>
            </thead>
            <tbody>
              {deployments.data?.map((d) => (
                <tr key={d.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-2">{d.channelName}</td>
                  <td className="py-2">{d.platform}</td>
                  <td className="py-2 font-mono">{d.runtimeVersion}</td>
                  <td className="py-2">
                    {d.directive ? (
                      <span className="text-red-600">rollBackToEmbedded</span>
                    ) : (
                      <span className="font-mono">#{d.releaseNumber}</span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-neutral-500">{formatDate(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="space-y-3 border-red-300 dark:border-red-900">
        <h2 className="font-medium text-red-700 dark:text-red-300">Roll back to embedded</h2>
        <p className="text-xs text-neutral-500">
          Kill-switch. Tells devices on this target to discard downloaded updates and run the bundle
          embedded in their binary — the only way to un-ship a bad update to devices that already
          took it, without publishing new JavaScript.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.data?.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Platform">
            <Select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as 'ios' | 'android')}
            >
              <option value="android">android</option>
              <option value="ios">ios</option>
            </Select>
          </Field>
          <Field label="Runtime version">
            <Input
              value={runtimeVersion}
              placeholder="1.0.0"
              onChange={(e) => setRuntimeVersion(e.target.value)}
            />
          </Field>
        </div>
        {killSwitch.isError && <ErrorNote>{errorMessage(killSwitch.error)}</ErrorNote>}
        <Button
          variant="danger"
          disabled={!runtimeVersion || killSwitch.isPending}
          onClick={() => killSwitch.mutate()}
        >
          Roll back to embedded
        </Button>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">History</h2>
        {events.data?.length === 0 && <p className="text-sm text-neutral-500">No changes yet.</p>}
        <ul className="space-y-1 text-sm">
          {events.data?.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-neutral-500">{formatDate(event.createdAt)}</span>
              <span className="font-medium">{event.action.replace(/_/g, ' ')}</span>
              <span className="text-neutral-500">
                {event.channelName} · {event.platform} · {event.runtimeVersion}
              </span>
              {event.toUpdateId && (
                <span className="font-mono text-xs text-neutral-400">
                  → {event.toUpdateId.slice(0, 8)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
