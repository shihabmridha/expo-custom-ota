import { resolve } from 'node:path';
import { migrate as migrateBunSqlite } from 'drizzle-orm/bun-sqlite/migrator';
import { migrate as migrateLibsql } from 'drizzle-orm/libsql/migrator';
import { createDb, type DbConfig, isFileUrl } from './client.ts';

/**
 * Apply pending migrations.
 *
 * Our own migrator rather than `drizzle-kit migrate`, so the production
 * container needs neither drizzle-kit nor its dev dependencies — the entrypoint
 * just runs this file.
 */
const MIGRATIONS_FOLDER = resolve(import.meta.dir, '../migrations');

export async function runMigrations(config: DbConfig): Promise<void> {
  const db = createDb(config);
  const options = { migrationsFolder: MIGRATIONS_FOLDER };

  if (isFileUrl(config.url)) {
    // biome-ignore lint/suspicious/noExplicitAny: the two migrators are typed against driver-specific database types that do not unify.
    migrateBunSqlite(db as any, options);
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    await migrateLibsql(db as any, options);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? 'file:./ota.db';
  const authToken = process.env.DATABASE_AUTH_TOKEN;

  console.log(`Applying migrations to ${url.startsWith('file:') ? url : '(remote libSQL)'}…`);
  await runMigrations({ url, authToken });
  console.log('Migrations applied.');
}
