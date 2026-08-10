import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Card, EmptyState, formatBytes } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

/**
 * Channel × runtime version × platform grid.
 *
 * This is the screen that answers "what is actually live right now", so it is
 * grouped the way that question is asked rather than by database row.
 */
export function OverviewPage() {
  const { id } = useParams<{ id: string }>();

  const deployments = useQuery({
    queryKey: qk.deployments(id!),
    queryFn: () => api.deployments.list({ params: { id: id! } }),
  });
  const metrics = useQuery({
    queryKey: qk.metrics(id!),
    queryFn: () => api.applications.metrics({ params: { id: id! } }),
  });

  const byChannel = new Map<string, Map<string, typeof deployments.data>>();
  for (const deployment of deployments.data ?? []) {
    const runtimes = byChannel.get(deployment.channelName) ?? new Map();
    const list = runtimes.get(deployment.runtimeVersion) ?? [];
    list.push(deployment);
    runtimes.set(deployment.runtimeVersion, list);
    byChannel.set(deployment.channelName, runtimes);
  }

  return (
    <div className="space-y-6">
      {metrics.data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <div className="text-sm text-neutral-500">Releases</div>
            <div className="text-2xl font-semibold">{metrics.data.totals.releases}</div>
          </Card>
          <Card>
            <div className="text-sm text-neutral-500">Assets</div>
            <div className="text-2xl font-semibold">{metrics.data.totals.assets}</div>
          </Card>
          <Card>
            <div className="text-sm text-neutral-500">Storage</div>
            <div className="text-2xl font-semibold">
              {formatBytes(metrics.data.totals.storageBytes)}
            </div>
          </Card>
        </div>
      )}

      {deployments.data?.length === 0 && (
        <EmptyState
          title="Nothing deployed"
          hint="Upload a release, then publish it to a channel."
        />
      )}

      {[...byChannel.entries()].map(([channel, runtimes]) => (
        <Card key={channel}>
          <h2 className="mb-3 font-medium">{channel}</h2>
          <div className="space-y-3">
            {[...runtimes.entries()]
              .sort(([a], [b]) => b.localeCompare(a))
              .map(([runtime, entries]) => (
                <div key={runtime}>
                  <div className="font-mono text-sm text-neutral-500">runtime {runtime}</div>
                  <ul className="mt-1 space-y-1">
                    {(entries ?? []).map((entry) => (
                      <li key={entry.id} className="flex items-center gap-3 text-sm">
                        <span className="w-16 text-neutral-500">{entry.platform}</span>
                        {entry.directive ? (
                          <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
                            rolled back to embedded
                          </span>
                        ) : (
                          <Link
                            to={`../releases/${entry.releaseId}`}
                            className="font-mono underline decoration-dotted"
                          >
                            #{entry.releaseNumber}
                          </Link>
                        )}
                        <span className="font-mono text-xs text-neutral-400">
                          {entry.updateId?.slice(0, 8)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
