import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  formatBytes,
  Input,
  PageHeader,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

const IMPORT_STEPS = ['uploaded', 'processing', 'assets_uploaded', 'ready'] as const;

/**
 * Release upload.
 *
 * The upload returns 202 and the import continues in the background, so this
 * screen polls until the release reaches a terminal state. A retry reuses the
 * same idempotency key, so a flaky connection cannot create duplicate releases.
 */
export function UploadReleasePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose an archive first');
      setProgress(0);
      return api.releases.import({
        params: { id: id! },
        query: { ...(message ? { message } : {}), filename: file.name },
        rawBody: file,
        onUploadProgress: (loaded, total) => setProgress(Math.round((loaded / total) * 100)),
      });
    },
    onSuccess: async (result) => {
      setReleaseId(result.releaseId);
      await queryClient.invalidateQueries({ queryKey: qk.releases(id!) });
    },
  });

  const release = useQuery({
    queryKey: qk.release(releaseId ?? ''),
    queryFn: () => api.releases.get({ params: { releaseId: releaseId! } }),
    enabled: Boolean(releaseId),
    // Stop polling once the import settles.
    refetchInterval: (query) => {
      const status = query.state.data?.importStatus;
      return status === 'ready' || status === 'failed' ? false : 1500;
    },
  });

  const status = release.data?.importStatus;
  const currentStep = status ? IMPORT_STEPS.indexOf(status as (typeof IMPORT_STEPS)[number]) : -1;

  return (
    <>
      <PageHeader
        title="Upload release"
        description="An expo export archive containing metadata.json, expoConfig.json, the bundles and assets."
      />

      <Card className="max-w-2xl space-y-4">
        {!releaseId && (
          <>
            <Field
              label="Archive"
              hint="Produced by `bun run scripts/pack-update.ts` in your Expo project."
            >
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm"
              />
            </Field>

            {file && (
              <p className="text-sm text-neutral-500">
                {file.name} — {formatBytes(file.size)}
              </p>
            )}

            <Field label="Message" hint="Optional. Shown in the release list.">
              <Input
                value={message}
                placeholder="Fix payment validation"
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>

            {upload.isPending && (
              <div>
                <div className="h-2 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full bg-neutral-900 transition-all dark:bg-white"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-neutral-500">Uploading… {progress}%</p>
              </div>
            )}

            {upload.isError && <ErrorNote>{errorMessage(upload.error)}</ErrorNote>}

            <Button
              variant="primary"
              disabled={!file || upload.isPending}
              onClick={() => upload.mutate()}
            >
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )}

        {releaseId && (
          <div className="space-y-4">
            <ol className="space-y-2">
              {IMPORT_STEPS.map((step, index) => (
                <li key={step} className="flex items-center gap-2 text-sm">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      status === 'failed'
                        ? 'bg-red-500'
                        : index <= currentStep
                          ? 'bg-green-500'
                          : 'bg-neutral-300 dark:bg-neutral-700'
                    }`}
                  />
                  <span className={index <= currentStep ? '' : 'text-neutral-500'}>
                    {step.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ol>

            {status && <Badge value={status} />}

            {status === 'failed' && (
              <>
                <ErrorNote>{release.data?.importError ?? 'Import failed'}</ErrorNote>
                <Button
                  onClick={() => {
                    // Same idempotency key: a retry resolves to the same
                    // release rather than creating a duplicate.
                    setReleaseId(null);
                    upload.reset();
                  }}
                >
                  Try again
                </Button>
              </>
            )}

            {status === 'ready' && (
              <Button variant="primary" onClick={() => void navigate(`../releases/${releaseId}`)}>
                Review release
              </Button>
            )}
          </div>
        )}

        <input type="hidden" value={idempotencyKey.current} />
      </Card>
    </>
  );
}
