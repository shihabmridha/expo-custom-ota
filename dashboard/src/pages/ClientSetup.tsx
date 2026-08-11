import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { Card, CopyBlock, PageHeader } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

/**
 * Everything needed to point an Expo app at this server.
 *
 * Most of what a self-hosted OTA server gets wrong shows up here, so the
 * snippet is generated rather than documented: the channel header name and the
 * keyid in particular must match exactly or the client silently refuses updates.
 */
export function ClientSetupPage() {
  const { id } = useParams<{ id: string }>();

  const config = useQuery({
    queryKey: qk.clientConfig(id!),
    queryFn: () => api.applications.clientConfig({ params: { id: id! } }),
  });

  const data = config.data;
  if (!data) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <PageHeader title="Client setup" />

      <Card className="space-y-3">
        <CopyBlock label="OTA URL" value={data.otaUrl} />
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyBlock
            label="Update key (public, goes in your updates URL / app.json)"
            value={data.updateKey}
          />
          <CopyBlock
            label="Application id (UUID — use for --app / OTA_APP_ID and all /api/admin routes)"
            value={data.applicationId}
          />
        </div>
      </Card>

      <Card className="space-y-3">
        <CopyBlock label="app.json" value={data.appJsonSnippet} />
        <ul className="space-y-1 text-xs text-neutral-500">
          <li>
            The channel is delivered through <code className="font-mono">requestHeaders</code> as{' '}
            <code className="font-mono">expo-channel-name</code>. It is not a protocol header.
          </li>
          <li>
            <code className="font-mono">runtimeVersion</code> must be an explicit string. A policy (
            <code className="font-mono">appVersion</code>,{' '}
            <code className="font-mono">fingerprint</code>) cannot be resolved server-side, and
            uploads using one are rejected.
          </li>
          <li>Updates are disabled in development builds — test against a release build.</li>
        </ul>
      </Card>

      {data.certificatePem ? (
        <Card className="space-y-3">
          <CopyBlock
            label="Code signing certificate (certs/certificate.pem)"
            value={data.certificatePem}
          />
          <p className="text-xs text-neutral-500">
            Save this as <code className="font-mono">certs/certificate.pem</code> in your project
            and commit it — it is a public certificate. The matching private key never leaves the
            server. Its <code className="font-mono">keyid</code> is{' '}
            <code className="font-mono">{data.keyId}</code> and must match{' '}
            <code className="font-mono">codeSigningMetadata.keyid</code> exactly, or the client
            rejects every update with “Key with keyid=… not found in client configuration”.
          </p>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-amber-700 dark:text-amber-300">
            This application has no signing key. Updates will be served unsigned, and any client
            configured for code signing will refuse them. Generate one on the Signing tab.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 font-medium">Channels</h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {data.channels.map((channel) => (
            <li
              key={channel}
              className="rounded bg-neutral-100 px-2 py-0.5 font-mono dark:bg-neutral-800"
            >
              {channel}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
