import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once at boot and frozen. A misconfigured server should fail
 * immediately with every problem listed, not surface a confusing error on the
 * first request that happens to need the missing value.
 */

const bytes = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** Baked into signed manifests as the asset URL prefix. */
    OTA_PUBLIC_URL: z
      .string()
      .url('OTA_PUBLIC_URL must be an absolute URL, e.g. https://ota.example.com')
      .transform((u) => u.replace(/\/+$/, ''))
      .default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1).default('file:./oat.db'),
    DATABASE_AUTH_TOKEN: z.string().optional(),

    STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./.storage'),

    R2_ENDPOINT: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_PUBLIC_URL: z.string().optional(),

    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters')
      .default('dev-only-insecure-session-secret-change-me'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),

    SIGNING_KEYS_DIRECTORY: z.string().default('./.signing-keys'),

    MAX_UPLOAD_BYTES: bytes(500 * 1024 * 1024),
    MAX_EXTRACTED_BYTES: bytes(1024 * 1024 * 1024),
    MAX_ARCHIVE_ENTRIES: bytes(20_000),
    MAX_COMPRESSION_RATIO: bytes(200),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 'r2') {
      for (const key of [
        'R2_ENDPOINT',
        'R2_BUCKET',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=r2`,
          });
        }
      }
    }

    if (env.NODE_ENV === 'production') {
      if (env.SESSION_SECRET.startsWith('dev-only')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'SESSION_SECRET must be set to a real secret in production',
        });
      }
      if (env.OTA_PUBLIC_URL.startsWith('http://localhost')) {
        ctx.addIssue({
          code: 'custom',
          path: ['OTA_PUBLIC_URL'],
          message:
            'OTA_PUBLIC_URL still points at localhost. It is baked into signed manifests, so ' +
            'publishing with this value produces asset URLs devices cannot reach.',
        });
      }
    }
  });

export type Env = Readonly<z.infer<typeof schema>> & {
  readonly isProduction: boolean;
  readonly storageLocalDirAbsolute: string;
  readonly signingKeysDirAbsolute: string;
};

function absolutize(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  const env = result.data;
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    // Resolved from cwd once, so a script run from a subdirectory cannot
    // silently point at a different storage or key directory.
    storageLocalDirAbsolute: absolutize(env.STORAGE_LOCAL_DIR),
    signingKeysDirAbsolute: absolutize(env.SIGNING_KEYS_DIRECTORY),
  });
}
