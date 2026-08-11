import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useParams } from 'react-router';
import { api } from '../lib/api.ts';
import { qk } from '../lib/queryClient.ts';

const TABS = [
  { to: '.', label: 'Overview', end: true },
  { to: 'releases', label: 'Releases' },
  { to: 'channels', label: 'Channels' },
  { to: 'deployments', label: 'Deployments' },
  { to: 'devices', label: 'Devices' },
  { to: 'client-setup', label: 'Client setup' },
  { to: 'signing', label: 'Signing' },
  { to: 'simulator', label: 'Simulator' },
  { to: 'settings', label: 'Settings' },
];

export function ApplicationLayout() {
  const { id } = useParams<{ id: string }>();

  const application = useQuery({
    queryKey: qk.application(id!),
    queryFn: () => api.applications.get({ params: { id: id! } }),
    enabled: Boolean(id),
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{application.data?.name ?? '…'}</h1>
        <p className="font-mono text-xs text-neutral-500">{application.data?.slug}</p>
      </div>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm ${
                isActive
                  ? 'border-neutral-900 font-medium dark:border-white'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
