import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';
import { Button } from './ui.tsx';

/**
 * Authenticated shell.
 *
 * The session probe returns 200 with a null admin when signed out, so a first
 * visit renders the login redirect rather than tripping error handling.
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: qk.session(),
    queryFn: () => api.auth.session(),
  });

  const logout = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: async () => {
      queryClient.clear();
      await navigate('/login');
    },
  });

  if (session.isLoading) {
    return <div className="p-8 text-sm text-neutral-500">Loading…</div>;
  }

  if (!session.data?.admin) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/applications" className="font-semibold tracking-tight">
            OAT
            <span className="ml-2 text-sm font-normal text-neutral-500">OTA Updates</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-neutral-500">{session.data.admin.email}</span>
            <Button onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
