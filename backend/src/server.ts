import { createDb } from '@oat/db';
import { createApp } from './app.ts';
import { loadEnv } from './config/env.ts';
import { createLogger } from './lib/logger.ts';
import { createStorage } from './storage/index.ts';

let env: ReturnType<typeof loadEnv>;
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
