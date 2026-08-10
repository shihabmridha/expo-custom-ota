import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit resolves `schema` and `out` relative to the **current working
 * directory**, not to this file — and it loads the config through esbuild,
 * where `import.meta.dir` is unavailable. So the package is located explicitly:
 * normally cwd is the repo root (all db scripts run from there), but running
 * from inside `packages/db` also works.
 */
const packageRoot = existsSync(resolve(process.cwd(), 'packages/db/src/schema'))
  ? resolve(process.cwd(), 'packages/db')
  : process.cwd();

/**
 * Paths are given **relative to cwd, with POSIX separators**, and both parts of
 * that matter on Windows:
 *
 *  - `schema` is globbed, and the glob engine treats `\` as an escape, so a
 *    native Windows path silently matches nothing: "No schema files found".
 *  - `out` is joined onto cwd internally, so an absolute path — even a
 *    forward-slashed one like `D:/…` — produces `D:\repo\D:\repo\…` and fails
 *    reading the snapshot with ENOENT.
 *
 * A relative POSIX path satisfies both.
 */
const fromCwd = (...segments: string[]) =>
  relative(process.cwd(), resolve(packageRoot, ...segments)).replace(/\\/g, '/') || '.';

export default defineConfig({
  dialect: 'turso',
  schema: fromCwd('src', 'schema', 'index.ts'),
  out: fromCwd('migrations'),
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./oat.db',
    ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
  },
  strict: true,
  verbose: true,
});
