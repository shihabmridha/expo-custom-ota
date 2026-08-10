import { Database } from 'bun:sqlite';
import { isAbsolute, resolve } from 'node:path';
import { createClient } from '@libsql/client/web';
import { drizzle as drizzleBunSqlite } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzleLibsql, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema/index.ts';

/**
 * Database client.
 *
 * Two drivers, chosen by URL scheme, both speaking the same `sqlite-core`
 * schema so the generated SQL is identical:
 *
 *   file:   -> bun:sqlite            (dev, tests, Windows)
 *   libsql: -> @libsql/client/web    (Turso, pure fetch)
 *
 * The `/web` entry point is deliberate: it avoids `@libsql/client`'s native
 * N-API bindings entirely, which is the least predictable part of this stack
 * under Bun on Windows.
 */

/**
 * The canonical database type.
 *
 * Both drivers speak the same `sqlite-core` schema and the same query builder,
 * but their Drizzle types are nominally distinct. A union of the two breaks
 * overload resolution on `.select({...})` — TypeScript reports "Expected 0
 * arguments" and drops the field selection — so we pin one type and cast the
 * other to it. The runtime APIs we use are identical; the query builders of
 * both drivers are thenable, so `await` works either way.
 */
export type OatDatabase = LibSQLDatabase<typeof schema>;

export interface DbConfig {
  url: string;
  authToken?: string | undefined;
}

/**
 * Resolve a `file:` URL to an absolute path.
 *
 * Bun loads `.env` from the current working directory and `file:./oat.db`
 * resolves from it too, so a script run from a package directory would
 * otherwise silently create a second, empty database.
 */
export function resolveFileUrl(url: string, cwd = process.cwd()): string {
  const raw = url.slice('file:'.length).replace(/^\/\//, '');
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export function isFileUrl(url: string): boolean {
  return url.startsWith('file:');
}

export function createDb(config: DbConfig): OatDatabase {
  if (isFileUrl(config.url)) {
    const sqlite = new Database(resolveFileUrl(config.url), { create: true });

    // `bun:sqlite` leaves foreign keys OFF by default. Without this every FK in
    // the schema is decorative and the isolation tests would pass vacuously.
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA busy_timeout = 5000;');

    return drizzleBunSqlite({ client: sqlite, schema }) as unknown as OatDatabase;
  }

  const client = createClient({
    url: config.url,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });
  return drizzleLibsql({ client, schema });
}

/** In-memory database for tests. Foreign keys on, same schema. */
export function createTestDb(): { db: OatDatabase; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return {
    db: drizzleBunSqlite({ client: sqlite, schema }) as unknown as OatDatabase,
    sqlite,
  };
}
