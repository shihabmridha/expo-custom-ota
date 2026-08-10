import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  CopyBlock,
  ErrorNote,
  formatDate,
  PageHeader,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function SigningPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const signing = useQuery({
    queryKey: qk.signing(id!),
    queryFn: () => api.signing.get({ params: { id: id! } }),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.signing.generate({
        params: { id: id! },
        body: { keyId: 'main', validityYears: 10 },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.signing(id!) });
      await queryClient.invalidateQueries({ queryKey: qk.clientConfig(id!) });
    },
  });

  const active = signing.data?.keys.find((key) => key.status === 'active');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Signing"
        description="Each application has its own key, so a compromise is contained to one app."
      />

      <Card className="space-y-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Private keys are written to the server's signing directory and never stored in the
          database, returned by the API, or sent to this dashboard.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Rotating the key does not re-sign existing releases. Anything already published was signed
          with the old key and will be refused by clients configured for the new certificate —
          republish after rotating.
        </p>
        {generate.isError && <ErrorNote>{errorMessage(generate.error)}</ErrorNote>}
        <Button variant="primary" disabled={generate.isPending} onClick={() => generate.mutate()}>
          {generate.isPending
            ? 'Generating…'
            : active
              ? 'Rotate signing key'
              : 'Generate signing key'}
        </Button>
      </Card>

      {signing.data?.keys.map((key) => (
        <Card key={`${key.keyId}-${key.createdAt}`} className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono font-medium">{key.keyId}</span>
            <Badge value={key.status} />
            <span className="text-xs text-neutral-500">
              expires {formatDate(key.certificateNotAfter)}
            </span>
          </div>
          <div className="font-mono text-xs break-all text-neutral-500">
            {key.certificateFingerprint}
          </div>
          {key.status === 'active' && (
            <CopyBlock label="certificate.pem" value={key.certificatePem} />
          )}
        </Card>
      ))}
    </div>
  );
}
