import { ApiError, createApiClient } from '@oat/api-client';

/**
 * The dashboard is served same-origin in both dev (through Vite's `/api` proxy)
 * and production (Bun serves the built SPA), so the base URL is always empty
 * and cookies simply work. No CORS configuration, no environment difference.
 */
export const api = createApiClient({ baseUrl: '' });

export { ApiError };

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export function fieldErrors(error: unknown): Record<string, string[]> {
  return error instanceof ApiError ? (error.fieldErrors ?? {}) : {};
}
