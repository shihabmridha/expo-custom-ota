import { Database } from 'bun:sqlite';
import { isAbsolute, resolve } from 'node:path';
import { type BunSQLiteDatabase, drizzle as drizzleBunSqlite } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema/index.ts';

/**
 * The canonical database type backed by native bun:sqlite.
 */
export type OtaDatabase = BunSQLiteDatabase<typeof schema>;

export interface DbConfig {
  url: string;
}

/**
 * Resolve a file URL or path to an absolute path for bun:sqlite.
 */
export function resolveFileUrl(url: string, cwd = process.cwd()): string {
  if (url === ':memory:') return ':memory:';
  const raw = url.startsWith('file:') ? url.slice('file:'.length).replace(/^\/\//, '') : url;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export function isFileUrl(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:';
}

/**
 * Create a bun:sqlite database connection with Drizzle ORM.
 */
export function createDb(config: DbConfig): OtaDatabase {
  const filePath = resolveFileUrl(config.url);
  const sqlite = new Database(filePath, { create: true });

  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');

  return drizzleBunSqlite({ client: sqlite, schema });
}

/** In-memory database for tests. Foreign keys on, same schema. */
export function createTestDb(): { db: OtaDatabase; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return {
    db: drizzleBunSqlite({ client: sqlite, schema }),
    sqlite,
  };
}
