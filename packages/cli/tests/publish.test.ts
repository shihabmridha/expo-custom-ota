import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishUpdate } from '../src/publish.ts';

/**
 * Regression coverage for GitHub issue #2, Issue 3: an update key (the
 * "ota_…" value from the updates URL) pasted into --app / OTA_APP_ID is the
 * predictable mistake, since it's the identifier users actually have to hand.
 * `publishUpdate` must reject it before any packing or network work happens,
 * with an explanation that names the mistake.
 *
 * No `@ota/api-sdk` mock is used here, unlike cli-options.test.ts — the check
 * runs before `packUpdate` is even called, so the honest way to prove no
 * upload happened is to point `projectDir` at a directory with no
 * `package.json`. If the ota_ check did not fire first, `packUpdate` would
 * run and throw *its own*, differently-worded error ("No package.json found
 * in …") instead of the update-key message, and would also never write
 * `outPath`. Getting the update-key message — and no file at `outPath` —
 * proves execution never reached `packUpdate`, let alone the network.
 */

const ENV_KEYS = [
  'OTA_SERVER_URL',
  'OTA_APP_ID',
  'OTA_CHANNEL',
  'OTA_EMAIL',
  'OTA_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let outPath: string;
let missingProjectDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  tmpDir = mkdtempSync(join(tmpdir(), 'publish-test-'));
  outPath = join(tmpDir, 'update.zip');
  missingProjectDir = join(tmpDir, 'nonexistent-project');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('publishUpdate rejects an update key passed as --app', () => {
  test('fails before packing, with an explanation naming the mistake', async () => {
    await expect(
      publishUpdate({
        serverUrl: 'https://ota.example.com',
        appId: 'ota_1UYGVxI7abcdef',
        email: 'admin@example.com',
        password: 'secret',
        projectDir: missingProjectDir,
        outPath,
      }),
    ).rejects.toThrow(/looks like an update key/);

    // packUpdate never ran (it would have thrown "No package.json found…"
    // instead, and never written outPath) — nothing was ever produced to upload.
    expect(existsSync(outPath)).toBe(false);
  });

  test('fires even when credentials are missing, i.e. before the credentials check', async () => {
    // The ota_ check sits above the credentials check in publishUpdate, so it
    // must win regardless of what else is missing.
    await expect(
      publishUpdate({
        serverUrl: 'https://ota.example.com',
        appId: 'ota_1UYGVxI7abcdef',
        projectDir: missingProjectDir,
        outPath,
      }),
    ).rejects.toThrow(/looks like an update key/);
  });

  test('applies to OTA_APP_ID from the environment, not just --app', async () => {
    process.env.OTA_APP_ID = 'ota_fromenv';
    await expect(
      publishUpdate({
        serverUrl: 'https://ota.example.com',
        email: 'admin@example.com',
        password: 'secret',
        projectDir: missingProjectDir,
        outPath,
      }),
    ).rejects.toThrow(/looks like an update key/);
  });

  test('an application id that merely contains "ota_" elsewhere is untouched', async () => {
    // Only a *leading* ota_ is the update-key shape; anything else must reach
    // packUpdate's own validation instead.
    await expect(
      publishUpdate({
        serverUrl: 'https://ota.example.com',
        appId: 'my-ota_app-uuid',
        email: 'admin@example.com',
        password: 'secret',
        projectDir: missingProjectDir,
        outPath,
      }),
    ).rejects.toThrow(/No package\.json found/);
  });
});
