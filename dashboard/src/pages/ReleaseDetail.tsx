import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  formatBytes,
  formatDate,
  PageHeader,
  Select,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

/** Release preview, publish, promote and rollback. */
export function ReleaseDetailPage() {
  const { id, releaseId } = useParams<{ id: string; releaseId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [channel, setChannel] = useState('staging');
  const [promoteFrom, setPromoteFrom] = useState('staging');
  const [promoteTo, setPromoteTo] = useState('production');

  const release = useQuery({
    queryKey: qk.release(releaseId!),
    queryFn: () => api.releases.get({ params: { releaseId: releaseId! } }),
  });
  const channels = useQuery({
    queryKey: qk.channels(id!),
    queryFn: () => api.channels.list({ params: { id: id! } }),
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.release(releaseId!) }),
      queryClient.invalidateQueries({ queryKey: qk.releases(id!) }),
      queryClient.invalidateQueries({ queryKey: qk.deployments(id!) }),
    ]);
  };

  const publish = useMutation({
    mutationFn: () =>
      api.releases.publish({ params: { releaseId: releaseId! }, body: { channel } }),
    onSuccess: invalidate,
  });

  const promote = useMutation({
    mutationFn: () =>
      api.releases.promote({
        params: { releaseId: releaseId! },
        body: { fromChannel: promoteFrom, toChannel: promoteTo },
      }),
    onSuccess: invalidate,
  });

  const rollback = useMutation({
    mutationFn: () =>
      api.releases.rollback({ params: { releaseId: releaseId! }, body: { channel: promoteTo } }),
    onSuccess: async (result) => {
      await invalidate();
      await navigate(`../releases/${result.releaseId}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.releases.remove({ params: { releaseId: releaseId! } }),
    onSuccess: async () => {
      await invalidate();
      await navigate('../releases');
    },
  });

  const data = release.data;
  if (!data) return <p className="text-sm text-neutral-500">Loading…</p>;

  const totalBytes = data.variants.reduce((sum, v) => sum + v.totalSizeBytes, 0);
  const channelNames = channels.data?.map((c) => c.name) ?? [];
  const anyError = publish.error ?? promote.error ?? rollback.error ?? remove.error;

  return (
    <>
      <PageHeader
        title={`Release #${data.releaseNumber}`}
        description={data.message ?? undefined}
        actions={<Badge value={data.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-medium">Contents</h2>

          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="pb-2 font-normal">Platform</th>
                <th className="pb-2 font-normal">Runtime</th>
                <th className="pb-2 font-normal">Assets</th>
                <th className="pb-2 font-normal">Bundle</th>
                <th className="pb-2 font-normal">Signed</th>
              </tr>
            </thead>
            <tbody>
              {data.variants.map((variant) => (
                <tr
                  key={variant.id}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2">{variant.platform}</td>
                  <td className="py-2 font-mono">{variant.runtimeVersion}</td>
                  <td className="py-2">{variant.assetCount}</td>
                  <td className="py-2">{formatBytes(variant.launchAssetSizeBytes)}</td>
                  <td className="py-2">
                    {variant.signed ? (
                      <span className="text-green-600">✓ {variant.signingKeyId}</span>
                    ) : (
                      <span className="text-amber-600">unsigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-4 space-y-1 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
            <div className="flex justify-between">
              <dt className="text-neutral-500">Total size</dt>
              <dd>{formatBytes(totalBytes)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-500">Created</dt>
              <dd>{formatDate(data.createdAt)}</dd>
            </div>
            {data.sourceFilename && (
              <div className="flex justify-between">
                <dt className="text-neutral-500">Source</dt>
                <dd className="font-mono text-xs">{data.sourceFilename}</dd>
              </div>
            )}
          </dl>

          {data.deployedTo.length > 0 && (
            <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <h3 className="mb-1 text-sm font-medium">Currently deployed to</h3>
              <ul className="space-y-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                {data.deployedTo.map((d) => (
                  <li key={`${d.channelName}-${d.platform}-${d.runtimeVersion}`}>
                    {d.channelName} · {d.platform} · runtime {d.runtimeVersion}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="space-y-3">
            <h2 className="font-medium">Publish</h2>
            <Field label="Channel">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="primary"
              className="w-full"
              disabled={data.importStatus !== 'ready' || publish.isPending}
              onClick={() => publish.mutate()}
            >
              {publish.isPending ? 'Publishing…' : `Publish to ${channel}`}
            </Button>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-medium">Promote</h2>
            <p className="text-xs text-neutral-500">
              Re-points the target channel at these exact variants. Nothing is rebuilt or re-signed,
              so what ships is byte-identical to what was tested.
            </p>
            <div className="flex gap-2">
              <Select value={promoteFrom} onChange={(e) => setPromoteFrom(e.target.value)}>
                {channelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select value={promoteTo} onChange={(e) => setPromoteTo(e.target.value)}>
                {channelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              className="w-full"
              disabled={promote.isPending}
              onClick={() => promote.mutate()}
            >
              {promote.isPending ? 'Promoting…' : 'Promote'}
            </Button>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-medium">Roll back to this release</h2>
            <p className="text-xs text-neutral-500">
              Creates a <em>new</em> release with these contents and a fresh update id, then
              publishes it to {promoteTo}. Devices are never pointed backwards at an old update.
            </p>
            <Button
              className="w-full"
              disabled={rollback.isPending}
              onClick={() => rollback.mutate()}
            >
              {rollback.isPending ? 'Rolling back…' : `Roll back into ${promoteTo}`}
            </Button>
          </Card>

          {data.status === 'draft' && (
            <Card>
              <Button
                variant="danger"
                className="w-full"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete draft
              </Button>
            </Card>
          )}

          {anyError && <ErrorNote>{errorMessage(anyError)}</ErrorNote>}
        </div>
      </div>
    </>
  );
}
