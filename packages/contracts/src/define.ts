import type { z } from 'zod';

/**
 * Route contracts.
 *
 * A contract is the single source of truth for one endpoint: the backend
 * validates against it and the client derives its types from it, so the two
 * cannot drift. Deleting a field from a schema breaks compilation on both
 * sides — which is the point.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Who may call the endpoint. */
export type AuthMode = 'admin' | 'public';

export interface RouteDef<
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  B extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  Q extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: M;
  /** Literal path with `:param` segments — the param names become typed. */
  path: P;
  body?: B;
  query?: Q;
  response: R;
  auth: AuthMode;
  /** `binary` routes send a raw body (a zip upload) rather than JSON. */
  contentType?: 'json' | 'binary';
  summary?: string;
}

/**
 * Identity helper that preserves literal types for `path` and `method` while
 * still checking the shape.
 */
export function route<
  M extends HttpMethod,
  P extends string,
  R extends z.ZodTypeAny,
  B extends z.ZodTypeAny | undefined = undefined,
  Q extends z.ZodTypeAny | undefined = undefined,
>(def: RouteDef<M, P, B, Q, R>): RouteDef<M, P, B, Q, R> {
  return def;
}

/**
 * Extract `:param` names from a literal path type.
 *
 * `'/apps/:id/channels/:channelId'` becomes `{ id: string; channelId: string }`.
 */
export type PathParams<P extends string> = string extends P
  ? Record<string, string>
  : P extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & PathParams<`/${Rest}`>
    : P extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : // biome-ignore lint/complexity/noBannedTypes: an empty object is exactly what "no path parameters" means.
        {};

export type RouteBody<T> =
  T extends RouteDef<HttpMethod, string, infer B, z.ZodTypeAny | undefined, z.ZodTypeAny>
    ? B extends z.ZodTypeAny
      ? z.input<B>
      : never
    : never;

export type RouteQuery<T> =
  T extends RouteDef<HttpMethod, string, z.ZodTypeAny | undefined, infer Q, z.ZodTypeAny>
    ? Q extends z.ZodTypeAny
      ? z.input<Q>
      : never
    : never;

export type RouteResponse<T> =
  T extends RouteDef<
    HttpMethod,
    string,
    z.ZodTypeAny | undefined,
    z.ZodTypeAny | undefined,
    infer R
  >
    ? z.infer<R>
    : never;

export type RoutePath<T> =
  T extends RouteDef<
    HttpMethod,
    infer P,
    z.ZodTypeAny | undefined,
    z.ZodTypeAny | undefined,
    z.ZodTypeAny
  >
    ? P
    : never;

/** Substitute path parameters, URL-encoding each value. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(value);
  });
}
