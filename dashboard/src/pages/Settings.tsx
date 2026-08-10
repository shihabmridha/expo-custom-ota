import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, ErrorNote, Field, Input, PageHeader } from '../components/ui.tsx';
import { api, errorMessage, fieldErrors } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const application = useQuery({
    queryKey: qk.application(id!),
    queryFn: () => api.applications.get({ params: { id: id! } }),
  });

  const [name, setName] = useState('');
  const [androidPackage, setAndroidPackage] = useState('');
  const [iosBundleIdentifier, setIosBundleIdentifier] = useState('');
  const [defaultChannel, setDefaultChannel] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');

  useEffect(() => {
    if (!application.data) return;
    setName(application.data.name);
    setAndroidPackage(application.data.androidPackage ?? '');
    setIosBundleIdentifier(application.data.iosBundleIdentifier ?? '');
    setDefaultChannel(application.data.defaultChannel);
  }, [application.data]);

  const save = useMutation({
    mutationFn: () =>
      api.applications.update({
        params: { id: id! },
        body: {
          name,
          androidPackage: androidPackage || null,
          iosBundleIdentifier: iosBundleIdentifier || null,
          defaultChannel,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.application(id!) });
      await queryClient.invalidateQueries({ queryKey: qk.applications() });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.applications.remove({ params: { id: id! } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.applications() });
      await navigate('/applications');
    },
  });

  const errors = fieldErrors(save.error);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" />

      <Card className="max-w-xl">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Name" errors={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Android package" errors={errors.androidPackage}>
            <Input value={androidPackage} onChange={(e) => setAndroidPackage(e.target.value)} />
          </Field>
          <Field label="iOS bundle identifier" errors={errors.iosBundleIdentifier}>
            <Input
              value={iosBundleIdentifier}
              onChange={(e) => setIosBundleIdentifier(e.target.value)}
            />
          </Field>
          <Field
            label="Default channel"
            hint="Used when a device sends no expo-channel-name header."
            errors={errors.defaultChannel}
          >
            <Input value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} />
          </Field>

          {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
          {save.isSuccess && <p className="text-sm text-green-600">Saved.</p>}

          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
        </form>
      </Card>

      <Card className="max-w-xl space-y-3 border-red-300 dark:border-red-900">
        <h2 className="font-medium text-red-700 dark:text-red-300">Delete application</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Removes every channel, release and deployment. Devices configured for this application
          will stop receiving updates and keep running whatever they last downloaded. Shared asset
          objects are left for garbage collection, since other applications may reference them.
        </p>
        <Field label={`Type "${application.data?.slug ?? ''}" to confirm`}>
          <Input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} />
        </Field>
        {remove.isError && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
        <Button
          variant="danger"
          disabled={confirmSlug !== application.data?.slug || remove.isPending}
          onClick={() => remove.mutate()}
        >
          Delete permanently
        </Button>
      </Card>
    </div>
  );
}
