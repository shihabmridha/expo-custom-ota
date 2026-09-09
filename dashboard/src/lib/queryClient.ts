import { ApiError } from '@ota/api-client';
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retrying a 4xx just repeats a request the server already rejected.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status >= 500 && failureCount < 2,
    },
  },
});

/** Query keys as a factory, so invalidation is never stringly-typed. */
export const qk = {
  session: () => ['session'] as const,
  applications: () => ['applications'] as const,
  application: (id: string) => ['applications', id] as const,
  channels: (id: string) => ['applications', id, 'channels'] as const,
  deployments: (id: string) => ['applications', id, 'deployments'] as const,
  deploymentEvents: (id: string) => ['applications', id, 'deployment-events'] as const,
  releases: (id: string) => ['applications', id, 'releases'] as const,
  release: (releaseId: string) => ['releases', releaseId] as const,
  clientConfig: (id: string) => ['applications', id, 'client-config'] as const,
  signing: (id: string) => ['applications', id, 'signing'] as const,
  metrics: (id: string) => ['applications', id, 'metrics'] as const,
  deviceMetrics: (id: string, filters: unknown) =>
    ['applications', id, 'device-metrics', filters] as const,
  deviceAdoption: (id: string) => ['applications', id, 'device-adoption'] as const,
  devices: (id: string, filters?: unknown) => ['applications', id, 'devices', filters] as const,
  deviceRecipients: (id: string, updateId: string, offset = 0) =>
    ['applications', id, 'updates', updateId, 'devices', offset] as const,
};
