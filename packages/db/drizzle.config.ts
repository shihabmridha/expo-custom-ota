import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit resolves `schema` and `out` relative to the **current working
 * directory**, not to this file — and it loads the config through esbuild,
 * where `import.meta.dir` is not available. So we locate the package
 * explicitly: normally cwd is the repo root (all db scripts run from there),
 * but running from inside `packages/db` also works.
 */
const packageRoot = existsSync(resolve(process.cwd(), 'packages/db/src/schema'))
  ? resolve(process.cwd(), 'packages/db')
  : process.cwd();

/**
 * drizzle-kit globs the schema path, and its glob engine treats `\` as an
 * escape character — a Windows path silently matches nothing and reports
 * "No schema files found". Always hand it POSIX separators.
 */
const posix = (p: string) => p.replace(/\\/g, '/');

export default defineConfig({
  dialect: 'turso',
  schema: posix(resolve(packageRoot, 'src/schema/index.ts')),
  out: posix(resolve(packageRoot, 'migrations')),
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./oat.db',
    ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
  },
  strict: true,
  verbose: true,
});
