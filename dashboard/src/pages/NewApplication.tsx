import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, ErrorNote, Field, Input, PageHeader } from '../components/ui.tsx';
import { api, errorMessage, fieldErrors } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

/** Derive a slug as the name is typed, while leaving it editable. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function NewApplicationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [androidPackage, setAndroidPackage] = useState('');
  const [iosBundleIdentifier, setIosBundleIdentifier] = useState('');
  const [generateSigningKey, setGenerateSigningKey] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      api.applications.create({
        body: {
          name,
          slug: slug || slugify(name),
          ...(androidPackage ? { androidPackage } : {}),
          ...(iosBundleIdentifier ? { iosBundleIdentifier } : {}),
          generateSigningKey,
        },
      }),
    onSuccess: async (app) => {
      await queryClient.invalidateQueries({ queryKey: qk.applications() });
      // Straight to client setup: the next thing anyone needs is the snippet.
      await navigate(`/applications/${app.id}/client-setup`);
    },
  });

  const errors = fieldErrors(create.error);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <>
      <PageHeader title="New application" />

      <Card className="max-w-xl">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Name" errors={errors.name}>
            <Input
              value={name}
              required
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          </Field>

          <Field label="Slug" hint="Used in URLs and file names." errors={errors.slug}>
            <Input
              value={slug}
              required
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </Field>

          <Field
            label="Android package"
            hint="Checked against every upload so another app's export cannot be published here."
            errors={errors.androidPackage}
          >
            <Input
              value={androidPackage}
              placeholder="xyz.acadion.mobile"
              onChange={(e) => setAndroidPackage(e.target.value)}
            />
          </Field>

          <Field label="iOS bundle identifier" errors={errors.iosBundleIdentifier}>
            <Input
              value={iosBundleIdentifier}
              placeholder="xyz.acadion.mobile"
              onChange={(e) => setIosBundleIdentifier(e.target.value)}
            />
          </Field>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={generateSigningKey}
              className="mt-1"
              onChange={(e) => setGenerateSigningKey(e.target.checked)}
            />
            <span>
              Generate a code signing key
              <span className="block text-xs text-neutral-500">
                RSA-2048 with a 10-year self-signed certificate. Without one, updates are served
                unsigned and a client configured for code signing will refuse them.
              </span>
            </span>
          </label>

          {create.isError && <ErrorNote>{errorMessage(create.error)}</ErrorNote>}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create application'}
            </Button>
            <Button onClick={() => void navigate('/applications')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
