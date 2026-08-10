import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, EmptyState, PageHeader } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function ApplicationsPage() {
  const applications = useQuery({
    queryKey: qk.applications(),
    queryFn: () => api.applications.list(),
  });

  return (
    <>
      <PageHeader
        title="Applications"
        description="Each application has its own update URL, channels and signing identity."
        actions={
          <Link
            to="/applications/new"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            + New application
          </Link>
        }
      />

      {applications.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}

      {applications.data?.length === 0 && (
        <EmptyState
          title="No applications yet"
          hint="Create one to get an OTA URL and a code signing certificate."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {applications.data?.map((app) => (
          <Link key={app.id} to={`/applications/${app.id}`}>
            <Card className="h-full transition hover:border-neutral-400 dark:hover:border-neutral-600">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-medium">{app.name}</h2>
                  <p className="font-mono text-xs text-neutral-500">{app.slug}</p>
                </div>
                {!app.hasSigningKey && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    unsigned
                  </span>
                )}
              </div>

              <dl className="mt-4 space-y-1 text-sm">
                {app.channelSummaries.length === 0 && (
                  <div className="text-neutral-500">Nothing deployed yet</div>
                )}
                {app.channelSummaries.map((channel) => (
                  <div key={channel.channel} className="flex justify-between">
                    <dt className="text-neutral-500">{channel.channel}</dt>
                    <dd className="font-mono">
                      {channel.latestReleaseNumber === null
                        ? '—'
                        : `#${channel.latestReleaseNumber}`}
                    </dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-neutral-200 pt-1 dark:border-neutral-800">
                  <dt className="text-neutral-500">Releases</dt>
                  <dd className="font-mono">{app.releaseCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">Runtimes</dt>
                  <dd className="font-mono">{app.runtimeVersionCount}</dd>
                </div>
              </dl>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
