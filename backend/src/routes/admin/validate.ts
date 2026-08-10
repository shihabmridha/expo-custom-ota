import type { Context, Handler } from 'hono';
import type { ZodType } from 'zod';
import type { AppEnv } from '../../app-env.ts';

/**
 * Contract-driven request validation.
 *
 * A handler names the contract it implements and receives the parsed body and
 * query already typed, so no route restates a schema and the backend cannot
 * disagree with the client about what a request looks like.
 *
 * Types are inferred from `ZodType<T>` directly rather than through a
 * conditional over the contract object: conditionals on an optional property
 * collapse to `never` here, and inference through the schema's own type
 * parameter is both simpler and more reliable.
 *
 * Deliberately not `@hono/zod-validator` — its inference depends on chaining
 * the validator into the route's generics, which is lost when middleware is
 * built from a registry.
 */

export interface ValidatedInput<TBody, TQuery> {
  body: TBody;
  query: TQuery;
}

function collectFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || '_';
    const bucket = fieldErrors[key] ?? [];
    bucket.push(issue.message);
    fieldErrors[key] = bucket;
  }
  return fieldErrors;
}

export function handle<TBody = undefined, TQuery = undefined>(
  contract: {
    body?: ZodType<TBody> | undefined;
    query?: ZodType<TQuery> | undefined;
  },
  fn: (c: Context<AppEnv>, input: ValidatedInput<TBody, TQuery>) => Response | Promise<Response>,
): Handler<AppEnv> {
  return async (c) => {
    const input = { body: undefined, query: undefined } as unknown as ValidatedInput<TBody, TQuery>;

    if (contract.body) {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(
          { code: 'VALIDATION_ERROR', message: 'Body must be valid JSON', fieldErrors: {} },
          422,
        );
      }

      const parsed = contract.body.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            code: 'VALIDATION_ERROR',
            message: 'Request failed validation',
            fieldErrors: collectFieldErrors(parsed.error.issues),
          },
          422,
        );
      }
      input.body = parsed.data;
    }

    if (contract.query) {
      const parsed = contract.query.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json(
          {
            code: 'VALIDATION_ERROR',
            message: 'Query failed validation',
            fieldErrors: collectFieldErrors(parsed.error.issues),
          },
          422,
        );
      }
      input.query = parsed.data;
    }

    return fn(c, input);
  };
}
