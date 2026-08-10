import type { OtaDatabase } from '@ota/db';
import type { AssetStorage } from '@ota/types';
import type { Env } from './config/env.ts';
import type { Logger } from './lib/logger.ts';
import type { SessionAdmin } from './services/auth.ts';

/** Context bound to every Hono request. */
export interface AppEnv {
  Variables: {
    db: OtaDatabase;
    storage: AssetStorage;
    env: Env;
    logger: Logger;
    requestId: string;
    /** Set by `requireAdmin`; absent on public routes. */
    admin?: SessionAdmin;
  };
}
