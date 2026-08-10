import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Card, ErrorNote, Field, Input } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const session = useQuery({ queryKey: qk.session(), queryFn: () => api.auth.session() });

  const login = useMutation({
    mutationFn: () => api.auth.login({ body: { email, password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.session() });
      await navigate('/applications');
    },
  });

  if (session.data?.admin) return <Navigate to="/applications" replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold">Sign in to OAT</h1>
        <p className="mb-5 text-sm text-neutral-500">
          There is no public registration. Create the first administrator with{' '}
          <code className="font-mono text-xs">bun run admin:create</code>.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              autoComplete="username"
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {login.isError && <ErrorNote>{errorMessage(login.error)}</ErrorNote>}

          <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
