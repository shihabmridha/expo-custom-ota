import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useParams } from 'react-router';
import { Button, Card, ErrorNote, Input, PageHeader } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function ChannelsPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const channels = useQuery({
    queryKey: qk.channels(id!),
    queryFn: () => api.channels.list({ params: { id: id! } }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.channels(id!) });

  const create = useMutation({
    mutationFn: () => api.channels.create({ params: { id: id! }, body: { name } }),
    onSuccess: async () => {
      setName('');
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (channelId: string) => api.channels.remove({ params: { channelId } }),
    onSuccess: invalidate,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <>
      <PageHeader
        title="Channels"
        description="Channel names are scoped to this application — another app's `production` is unrelated."
      />

      <Card className="mb-4">
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input
            value={name}
            placeholder="beta"
            required
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add
          </Button>
        </form>
        {(create.isError || remove.isError) && (
          <div className="mt-3">
            <ErrorNote>{errorMessage(create.error ?? remove.error)}</ErrorNote>
          </div>
        )}
      </Card>

      <div className="space-y-2">
        {channels.data?.map((channel) => (
          <Card key={channel.id} className="flex items-center justify-between">
            <span className="font-mono text-sm">{channel.name}</span>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(channel.id)}
            >
              Delete
            </Button>
          </Card>
        ))}
      </div>
    </>
  );
}
