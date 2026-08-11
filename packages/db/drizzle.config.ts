import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const packageRoot = existsSync(resolve(process.cwd(), 'packages/db/src/schema'))
  ? resolve(process.cwd(), 'packages/db')
  : process.cwd();

const fromCwd = (...segments: string[]) =>
  relative(process.cwd(), resolve(packageRoot, ...segments)).replace(/\\/g, '/') || '.';

export default defineConfig({
  dialect: 'sqlite',
  schema: fromCwd('src', 'schema', 'index.ts'),
  out: fromCwd('migrations'),
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./ota.db',
  },
  strict: true,
  verbose: true,
});
