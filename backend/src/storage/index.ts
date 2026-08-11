import type { AssetStorage } from '@ota/types';
import type { Env } from '../config/env.ts';
import { LocalAssetStorage } from './local.ts';

export { LocalAssetStorage } from './local.ts';

export function createStorage(env: Env): AssetStorage {
  return new LocalAssetStorage(env.storageLocalDirAbsolute, env.OTA_PUBLIC_URL);
}
