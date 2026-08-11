import { createDb, type OtaDatabase, runMigrations } from '@ota/db';
import { sql } from 'drizzle-orm';
import { createApp } from './app.ts';
import { type Env, loadEnv } from './config/env.ts';
import { createLogger } from './lib/logger.ts';
import { createStorage } from './storage/index.ts';

let env: Env;
try {
  env = loadEnv();
} catch (error) {
  // Must be console.error, not logger.error: the logger is not constructed
  // until env.LOG_LEVEL below, and env loading is exactly what just failed.
  console.error((error as Error).message);
  process.exit(1);
}

const logger = createLogger(env.LOG_LEVEL);

// Programmatically apply Drizzle migrations on backend startup
try {
  logger.info('applying_database_migrations', {
    database: env.DATABASE_URL,
  });
  await runMigrations({ url: env.DATABASE_URL });
} catch (error) {
  logger.error('migration_failed', { message: (error as Error).message });
  process.exit(1);
}

const db = createDb({ url: env.DATABASE_URL });
const storage = createStorage(env);

/**
 * Verify database schema after migrations.
 */
async function assertMigrated(database: OtaDatabase, current: Env): Promise<void> {
  const where = current.DATABASE_URL;

  let hasSchema: boolean;
  try {
    const rows = await database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admins' LIMIT 1`,
    );
    hasSchema = rows.length > 0;
  } catch (error) {
    logger.error('database_failure', {
      message: `Could not reach the database at ${where}: ${(error as Error).message}`,
    });
    process.exit(1);
  }

  if (!hasSchema) {
    logger.error('database_failure', {
      message: `The database at ${where} has no schema — migrations failed to create schema.`,
    });
    process.exit(1);
  }
}

await assertMigrated(db, env);

const app = createApp({ env, db, storage, logger });

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  maxRequestBodySize: env.MAX_UPLOAD_BYTES,
  idleTimeout: 60,
});

logger.info('server_started', {
  port: server.port,
  publicUrl: env.OTA_PUBLIC_URL,
  database: env.DATABASE_URL,
});
