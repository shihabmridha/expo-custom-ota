import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, Card, EmptyState, formatDate, PageHeader } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function ReleasesPage() {
  const { id } = useParams<{ id: string }>();

  const releases = useQuery({
    queryKey: qk.releases(id!),
    queryFn: () => api.releases.list({ params: { id: id! } }),
  });

  return (
    <>
      <PageHeader
        title="Releases"
        actions={
          <Link
            to="upload"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Upload release
          </Link>
        }
      />

      {releases.data?.length === 0 && (
        <EmptyState
          title="No releases yet"
          hint="Run `bun run scripts/pack-update.ts` in your Expo project, then upload the archive."
        />
      )}

      <div className="space-y-2">
        {releases.data?.map((release) => (
          <Link key={release.id} to={release.id}>
            <Card className="transition hover:border-neutral-400 dark:hover:border-neutral-600">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono font-medium">#{release.releaseNumber}</span>
                <Badge value={release.status} />
                {release.importStatus !== 'ready' && <Badge value={release.importStatus} />}
                {release.rollbackOfReleaseId && (
                  <span className="text-xs text-neutral-500">rollback</span>
                )}
                <span className="flex-1 truncate text-sm text-neutral-600 dark:text-neutral-400">
                  {release.message ?? '—'}
                </span>
                <span className="text-xs text-neutral-500">{formatDate(release.createdAt)}</span>
              </div>
              {release.importError && (
                <p className="mt-2 text-xs whitespace-pre-wrap text-red-600">
                  {release.importError}
                </p>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
