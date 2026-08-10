import type { OatDatabase } from '@oat/db';
import type { AssetStorage } from '@oat/types';
import type { Env } from './config/env.ts';
import type { Logger } from './lib/logger.ts';

/** Context bound to every Hono request. */
export interface AppEnv {
  Variables: {
    db: OatDatabase;
    storage: AssetStorage;
    env: Env;
    logger: Logger;
    requestId: string;
  };
}
