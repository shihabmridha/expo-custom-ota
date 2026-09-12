export interface SourceMetadata {
  schemaVersion: 1;
  sourceRevision: string;
  gitCommit: string;
  application: string;
  environment: string;
  platform: 'android';
  runtimeVersion: string;
  appVersion: string;
  nativeVersionCode: number;
  toolchain: {
    bun: string;
    node: string;
    expo: string;
    reactNative: string;
    expoUpdates: string;
  };
  publicConfigDigest: string;
}
