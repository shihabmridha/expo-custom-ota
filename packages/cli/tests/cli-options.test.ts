import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExpoPublicConfig } from '../src/pack.ts';

/**
 * `publishUpdate` composes `packUpdate` (packages an export) and `OtaClient`
 * (talks to the server). Only `@ota/api-sdk` is mocked here, so no network call
 * ever happens; `packUpdate` runs for real against the same static fixture
 * `pack.test.ts` uses (via `loadExpoConfig`, so no `@expo/config` needed
 * either), which keeps these tests exercising the real option/env precedence
 * and validation in `publishUpdate` end to end.
 *
 * `@ota/api-sdk` is mocked with `mock.module`, which patches the module
 * registry for the whole test run — safe here because no other test file in
 * this run imports the bare `@ota/api-sdk` specifier.
 */

const loginMock = mock(async (_email: string, _password: string) => {});
const importAndPublishMock = mock(
  async (
    _appId: string,
    _archive: Uint8Array,
    _options: { channel: string; message?: string },
  ) => ({
    releaseId: 'rel_1',
    status: 'published',
  }),
);
const constructedWith: { baseUrl: string }[] = [];

mock.module('@ota/api-sdk', () => ({
  OtaClient: class {
    login = loginMock;
    importAndPublish = importAndPublishMock;
    constructor(options: { baseUrl: string }) {
      constructedWith.push(options);
    }
  },
}));

const { publishUpdate } = await import('../src/publish.ts');

const PROJECT_DIR = join(import.meta.dir, 'fixtures', 'project');
const stringRuntimeVersion: ExpoPublicConfig = { exp: { runtimeVersion: '1.0.0' } };

const ENV_KEYS = [
  'OTA_SERVER_URL',
  'OTA_APP_ID',
  'OTA_CHANNEL',
  'OTA_EMAIL',
  'OTA_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  loginMock.mockClear();
  importAndPublishMock.mockClear();
  constructedWith.length = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-options-test-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Base options that get `packUpdate` through packaging without touching the network. */
function baseOptions() {
  return {
    projectDir: PROJECT_DIR,
    outPath: join(tmpDir, 'update.zip'),
    skipExport: true,
    quiet: true,
    loadExpoConfig: async () => stringRuntimeVersion,
  };
}

describe('publishUpdate option/env precedence', () => {
  test('--server (options.serverUrl) beats OTA_SERVER_URL', async () => {
    process.env.OTA_SERVER_URL = 'https://env.example.com';

    await publishUpdate({
      ...baseOptions(),
      serverUrl: 'https://option.example.com',
      appId: 'app_1',
      email: 'admin@example.com',
      password: 'secret',
    });

    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(constructedWith[0]?.baseUrl).toBe('https://option.example.com');
  });

  test('falls back to OTA_SERVER_URL when --server is not given', async () => {
    process.env.OTA_SERVER_URL = 'https://env.example.com';

    await publishUpdate({
      ...baseOptions(),
      appId: 'app_1',
      email: 'admin@example.com',
      password: 'secret',
    });

    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(constructedWith[0]?.baseUrl).toBe('https://env.example.com');
  });

  test('throws the documented message when neither --server nor OTA_SERVER_URL is set', async () => {
    await expect(
      publishUpdate({
        ...baseOptions(),
        appId: 'app_1',
        email: 'admin@example.com',
        password: 'secret',
      }),
    ).rejects.toThrow('Server URL is required. Pass --server <url> or set OTA_SERVER_URL.');

    expect(loginMock).not.toHaveBeenCalled();
  });

  test('throws when the application id is missing from both option and env', async () => {
    await expect(
      publishUpdate({
        ...baseOptions(),
        serverUrl: 'https://ota.example.com',
        email: 'admin@example.com',
        password: 'secret',
      }),
    ).rejects.toThrow('Application ID is required. Pass --app <id> or set OTA_APP_ID.');
  });

  test('throws when credentials are missing from both option and env', async () => {
    await expect(
      publishUpdate({
        ...baseOptions(),
        serverUrl: 'https://ota.example.com',
        appId: 'app_1',
      }),
    ).rejects.toThrow(/Credentials are required for publishing/);
  });

  test('defaults the channel to "production" when unset', async () => {
    await publishUpdate({
      ...baseOptions(),
      serverUrl: 'https://ota.example.com',
      appId: 'app_1',
      email: 'admin@example.com',
      password: 'secret',
    });

    expect(importAndPublishMock).toHaveBeenCalledTimes(1);
    // importAndPublish is called as (appId, archive, { channel, message }).
    const options = importAndPublishMock.mock.calls[0]?.[2] as { channel: string };
    expect(options.channel).toBe('production');
  });

  test('falls back to OTA_CHANNEL when --channel is not given', async () => {
    process.env.OTA_CHANNEL = 'staging';

    await publishUpdate({
      ...baseOptions(),
      serverUrl: 'https://ota.example.com',
      appId: 'app_1',
      email: 'admin@example.com',
      password: 'secret',
    });

    const options = importAndPublishMock.mock.calls[0]?.[2] as { channel: string };
    expect(options.channel).toBe('staging');
  });

  test('--channel (options.channel) beats OTA_CHANNEL', async () => {
    process.env.OTA_CHANNEL = 'staging';

    await publishUpdate({
      ...baseOptions(),
      serverUrl: 'https://ota.example.com',
      appId: 'app_1',
      channel: 'preview',
      email: 'admin@example.com',
      password: 'secret',
    });

    const options = importAndPublishMock.mock.calls[0]?.[2] as { channel: string };
    expect(options.channel).toBe('preview');
  });
});
