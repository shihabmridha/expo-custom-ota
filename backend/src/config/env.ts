import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once at boot using Zod and frozen.
 * Bun auto-loads .env files into process.env.
 */

const bytes = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/**
 * Zod schema for environment variable validation.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** Baked into signed manifests as the asset URL prefix. */
    OTA_PUBLIC_URL: z
      .url({ error: 'OTA_PUBLIC_URL must be an absolute URL, e.g. https://ota.example.com' })
      .transform((u) => u.replace(/\/+$/, ''))
      .default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1).default('file:./ota.db'),

    STORAGE_LOCAL_DIR: z.string().default('./.storage'),

    SESSION_SECRET: z
      .string()
      .min(32, { error: 'SESSION_SECRET must be at least 32 characters' })
      .default('dev-only-insecure-session-secret-change-me'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),

    SIGNING_KEYS_DIRECTORY: z.string().default('./.signing-keys'),

    MAX_UPLOAD_BYTES: bytes(500 * 1024 * 1024),
    MAX_EXTRACTED_BYTES: bytes(1024 * 1024 * 1024),
    MAX_ARCHIVE_ENTRIES: bytes(20_000),
    MAX_COMPRESSION_RATIO: bytes(200),

    /**
     * Per-install update tracking (`device_installs` / `device_update_events`).
     * Set false to store no device identifiers at all; the anonymous daily
     * counters in `usage_daily` are unaffected either way. See D16 in
     * `docs/decisions.md`.
     */
    DEVICE_TRACKING_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v === 'true' || v === '1'),

    /** Age at which `bun run prune:devices` drops rows. 0 keeps them forever. */
    DEVICE_TRACKING_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),

    /** Absolute path to the built dashboard. Unset means API-only. */
    DASHBOARD_DIST: z.string().optional(),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
  })
  .superRefine((env, ctx) => {
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

export type RawEnvInput = z.input<typeof envSchema>;
export type ParsedEnv = z.infer<typeof envSchema>;

export type Env = Readonly<ParsedEnv> & {
  readonly isProduction: boolean;
  readonly storageLocalDirAbsolute: string;
  readonly signingKeysDirAbsolute: string;
  readonly databaseUrlAbsolute: string;
};

/**
 * Parse environment variables directly from process.env using Zod schema.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Ignore empty string values so defaults apply
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') {
      cleaned[key] = value;
    }
  }

  const result = envSchema.safeParse(cleaned);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  const env = result.data;
  const cwd = process.cwd();
  const absolutize = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

  const databaseUrlAbsolute = env.DATABASE_URL.startsWith('file:')
    ? `file:${absolutize(env.DATABASE_URL.slice('file:'.length).replace(/^\/\//, ''))}`
    : env.DATABASE_URL;

  return Object.freeze({
    ...env,
    DATABASE_URL: databaseUrlAbsolute,
    databaseUrlAbsolute,
    isProduction: env.NODE_ENV === 'production',
    storageLocalDirAbsolute: absolutize(env.STORAGE_LOCAL_DIR),
    signingKeysDirAbsolute: absolutize(env.SIGNING_KEYS_DIRECTORY),
  });
}
