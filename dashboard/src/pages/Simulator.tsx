import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  Card,
  CopyBlock,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

/**
 * Replays an update request server-side.
 *
 * This is the screen that diagnoses "my device isn't updating" without needing
 * the device — including whether the stored signature still verifies against
 * the stored certificate, which is the failure rotation causes.
 */
export function SimulatorPage() {
  const { id } = useParams<{ id: string }>();

  const [platform, setPlatform] = useState<'ios' | 'android'>('android');
  const [runtimeVersion, setRuntimeVersion] = useState('1.0.0');
  const [channelName, setChannelName] = useState('');
  const [currentUpdateId, setCurrentUpdateId] = useState('');
  const [expectSignature, setExpectSignature] = useState(true);

  const channels = useQuery({
    queryKey: qk.channels(id!),
    queryFn: () => api.channels.list({ params: { id: id! } }),
  });

  const simulate = useMutation({
    mutationFn: () =>
      api.applications.simulate({
        params: { id: id! },
        body: {
          platform,
          runtimeVersion,
          ...(channelName ? { channelName } : {}),
          ...(currentUpdateId ? { currentUpdateId } : {}),
          expectSignature,
        },
      }),
  });

  const result = simulate.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Simulator"
        description="Replay exactly what a device would ask for, and see exactly what it would get."
      />

      <Card className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
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
            <Input value={runtimeVersion} onChange={(e) => setRuntimeVersion(e.target.value)} />
          </Field>
          <Field label="Channel" hint="Blank uses the application default.">
            <Select value={channelName} onChange={(e) => setChannelName(e.target.value)}>
              <option value="">(default)</option>
              {channels.data?.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Current update id" hint="Simulates a device that already has an update.">
            <Input
              value={currentUpdateId}
              placeholder="(none)"
              onChange={(e) => setCurrentUpdateId(e.target.value)}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={expectSignature}
            onChange={(e) => setExpectSignature(e.target.checked)}
          />
          Client expects a signature
        </label>

        {simulate.isError && <ErrorNote>{errorMessage(simulate.error)}</ErrorNote>}

        <Button variant="primary" disabled={simulate.isPending} onClick={() => simulate.mutate()}>
          {simulate.isPending ? 'Running…' : 'Send request'}
        </Button>
      </Card>

      {result && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono">HTTP {result.status}</span>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs dark:bg-neutral-800">
              {result.decision}
            </span>
            {result.signatureVerified === true && (
              <span className="text-green-600">✓ signature verifies</span>
            )}
            {result.signatureVerified === false && (
              <span className="text-red-600">✗ signature does NOT verify</span>
            )}
          </div>

          {result.notes.length > 0 && (
            <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-300">
              {result.notes.map((note) => (
                <li key={note}>• {note}</li>
              ))}
            </ul>
          )}

          <CopyBlock
            label="Response headers"
            value={Object.entries(result.headers)
              .map(([key, value]) => `${key}: ${value}`)
              .join('\n')}
          />

          {result.manifest && (
            <CopyBlock
              label="Manifest"
              value={JSON.stringify(JSON.parse(result.manifest), null, 2)}
            />
          )}
          {result.directive && <CopyBlock label="Directive" value={result.directive} />}
        </Card>
      )}
    </div>
  );
}
