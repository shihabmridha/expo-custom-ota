import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once at boot and frozen. A misconfigured server should fail
 * immediately with every problem listed, not surface a confusing error on the
 * first request that happens to need the missing value.
 *
 * Everything anchors to the **repository root**, not the working directory.
 * Bun auto-loads `.env` from cwd, so launching the server from `backend/`
 * — which `bun run --filter '*' dev` does — would otherwise miss the root
 * `.env` entirely, silently fall back to the default `file:./ota.db`, and
 * create a second, empty database. The failure surfaces much later as
 * "no such table: admins".
 */

/** Walk up to the workspace root (the package.json declaring `workspaces`). */
export function findRepoRoot(from = import.meta.dir): string {
  let dir = from;
  for (let depth = 0; depth < 10; depth++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir;
      } catch {
        // Unparseable package.json — keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Minimal `.env` parser.
 *
 * Only used to backfill values Bun did not already load, so process
 * environment and a cwd-local `.env` always win. Deliberately not a dependency:
 * this handles `KEY=value`, comments, blank lines and optional quotes, which is
 * the whole format we use.
 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equals = line.indexOf('=');
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

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

    DATABASE_URL: z.string().min(1).default('file:./ota.db'),
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

    /** Absolute path to the built dashboard. Unset means API-only. */
    DASHBOARD_DIST: z.string().optional(),

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
  readonly repoRoot: string;
  readonly storageLocalDirAbsolute: string;
  readonly signingKeysDirAbsolute: string;
  readonly databaseUrlAbsolute: string;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const repoRoot = findRepoRoot();

  // Backfill from the repo-root .env for anything the process environment does
  // not already define, so the server behaves identically however it is
  // launched. Explicit environment always wins.
  const fromRootEnvFile = readEnvFile(join(repoRoot, '.env'));
  const merged: Record<string, string | undefined> = { ...fromRootEnvFile };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }

  const absolutize = (path: string) => (isAbsolute(path) ? path : resolve(repoRoot, path));

  const result = schema.safeParse(merged);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  const env = result.data;

  // A relative `file:` database path is resolved against the repo root too,
  // for the same reason: otherwise `bun run dev` and `bun run dev:api` would
  // open different databases.
  const databaseUrlAbsolute = env.DATABASE_URL.startsWith('file:')
    ? `file:${absolutize(env.DATABASE_URL.slice('file:'.length).replace(/^\/\//, ''))}`
    : env.DATABASE_URL;

  return Object.freeze({
    ...env,
    DATABASE_URL: databaseUrlAbsolute,
    databaseUrlAbsolute,
    isProduction: env.NODE_ENV === 'production',
    repoRoot,
    storageLocalDirAbsolute: absolutize(env.STORAGE_LOCAL_DIR),
    signingKeysDirAbsolute: absolutize(env.SIGNING_KEYS_DIRECTORY),
  });
}
