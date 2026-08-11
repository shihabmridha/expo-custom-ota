import { z } from 'zod';

export const platformSchema = z.enum(['ios', 'android']);
export const releaseStatusSchema = z.enum(['draft', 'published', 'archived']);
export const importStatusSchema = z.enum([
  'uploaded',
  'processing',
  'assets_uploaded',
  'ready',
  'failed',
]);

/** Uniform error body. Every non-2xx admin response uses this shape. */
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Present on 422s, keyed by field path. */
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Slugs and channel names appear in URLs and config snippets, so they are
 * restricted to characters that need no escaping anywhere.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    error: 'Must be lowercase alphanumeric with single hyphens, e.g. "acadion-mobile"',
  });

export const channelNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, {
    error: 'Must be lowercase alphanumeric with hyphens or underscores',
  });

/**
 * Runtime versions are opaque strings defined by the developer — never parsed
 * or compared semantically, only matched exactly.
 */
export const runtimeVersionSchema = z.string().min(1).max(128);

/** A native application identifier, e.g. `xyz.acadion.mobile`. */
export const bundleIdentifierSchema = z
  .string()
  .min(1)
  .max(155)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, {
    error: 'Must be a reverse-DNS identifier, e.g. "xyz.acadion.mobile"',
  });
