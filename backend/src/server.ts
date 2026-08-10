import { createDb, type OtaDatabase } from '@ota/db';
import { sql } from 'drizzle-orm';
import { createApp } from './app.ts';
import { type Env, loadEnv } from './config/env.ts';
import { createLogger } from './lib/logger.ts';
import { createStorage } from './storage/index.ts';

let env: Env;
try {
  env = loadEnv();
} catch (error) {
  // Fail fast and loudly: a server that boots with bad configuration produces
  // confusing failures much later.
  console.error((error as Error).message);
  process.exit(1);
}

const logger = createLogger(env.LOG_LEVEL);
const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
const storage = createStorage(env);

/**
 * Refuse to start against an unmigrated database.
 *
 * Without this the server boots happily and the first login fails with
 * "no such table: admins" — an error that points at the query rather than at
 * the cause, and which looks identical whether migrations were never run or the
 * server is pointed at the wrong database entirely. Both are worth naming.
 */
async function assertMigrated(database: OtaDatabase, current: Env): Promise<void> {
  const where = current.DATABASE_URL.startsWith('file:') ? current.DATABASE_URL : '(remote libSQL)';

  let hasSchema: boolean;
  try {
    const rows = await database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admins' LIMIT 1`,
    );
    hasSchema = rows.length > 0;
  } catch (error) {
    console.error(`Could not reach the database at ${where}\n  ${(error as Error).message}`);
    process.exit(1);
  }

  if (!hasSchema) {
    console.error(
      `The database at ${where} has no schema — migrations have not been applied.\n\n` +
        '  bun run db:migrate\n\n' +
        'If you expected data here, check DATABASE_URL: this is the database the server ' +
        'resolved, and a relative file: path is resolved against the repository root.',
    );
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
  storageDriver: env.STORAGE_DRIVER,
  database: env.DATABASE_URL.startsWith('file:') ? env.DATABASE_URL : '(remote libSQL)',
});
