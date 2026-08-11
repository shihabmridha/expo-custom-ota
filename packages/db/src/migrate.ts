import { resolve } from 'node:path';
import { migrate as migrateBunSqlite } from 'drizzle-orm/bun-sqlite/migrator';
import { createDb, type DbConfig } from './client.ts';

const MIGRATIONS_FOLDER = resolve(import.meta.dir, '../migrations');

export async function runMigrations(config: DbConfig): Promise<void> {
  const db = createDb(config);
  migrateBunSqlite(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? 'file:./ota.db';

  console.log(`Applying migrations to ${url}…`);
  await runMigrations({ url });
  console.log('Migrations applied successfully.');
}
