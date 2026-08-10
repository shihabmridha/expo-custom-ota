import type { AssetStorage } from '@oat/types';
import type { Env } from '../config/env.ts';
import { LocalAssetStorage } from './local.ts';
import { R2AssetStorage } from './r2.ts';

export { LocalAssetStorage } from './local.ts';
export { R2AssetStorage } from './r2.ts';

export function createStorage(env: Env): AssetStorage {
  if (env.STORAGE_DRIVER === 'local') {
    return new LocalAssetStorage(env.storageLocalDirAbsolute, env.OTA_PUBLIC_URL);
  }

  return new R2AssetStorage(
    {
      endpoint: env.R2_ENDPOINT!,
      bucket: env.R2_BUCKET!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
    env.R2_PUBLIC_URL ? env.R2_PUBLIC_URL.replace(/\/+$/, '') : null,
    env.OTA_PUBLIC_URL,
  );
}
