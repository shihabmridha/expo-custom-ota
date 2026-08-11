import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { type ExpoPublicConfig, packUpdate } from '../src/pack.ts';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
const PROJECT_DIR = join(FIXTURES_DIR, 'project');
const NO_METADATA_DIR = join(FIXTURES_DIR, 'no-metadata');

const stringRuntimeVersion: ExpoPublicConfig = { exp: { runtimeVersion: '1.0.0' } };
const policyRuntimeVersion: ExpoPublicConfig = {
  exp: { runtimeVersion: { policy: 'appVersion' } },
};
const noRuntimeVersion: ExpoPublicConfig = { exp: {} };

async function loadConfig(config: ExpoPublicConfig) {
  return config;
}

let tmpDir: string;
let outPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pack-test-'));
  outPath = join(tmpDir, 'update.zip');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('packUpdate', () => {
  test('zip entry names are POSIX even on a Windows checkout', async () => {
    const result = await packUpdate({
      projectDir: PROJECT_DIR,
      outPath,
      skipExport: true,
      quiet: true,
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
    });

    const entries = unzipSync(result.archive);
    const names = Object.keys(entries);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toContain('\\');
    }
    expect(names).toContain('metadata.json');
    expect(names).toContain('_expo/static/js/ios/index-abc123.hbc');
  });

  test('embeds expoConfig.json, and it parses back to the loaded config', async () => {
    const result = await packUpdate({
      projectDir: PROJECT_DIR,
      outPath,
      skipExport: true,
      quiet: true,
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
    });

    const entries = unzipSync(result.archive);
    expect(entries['expoConfig.json']).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(entries['expoConfig.json']));
    expect(parsed.runtimeVersion).toBe('1.0.0');
  });

  test('throws when dist/metadata.json is missing', async () => {
    await expect(
      packUpdate({
        projectDir: NO_METADATA_DIR,
        outPath,
        skipExport: true,
        quiet: true,
        loadExpoConfig: () => loadConfig(stringRuntimeVersion),
      }),
    ).rejects.toThrow(/metadata\.json is missing/);
  });

  test('warns when runtimeVersion is absent', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await packUpdate({
        projectDir: PROJECT_DIR,
        outPath,
        skipExport: true,
        loadExpoConfig: () => loadConfig(noRuntimeVersion),
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('No runtimeVersion'))).toBe(true);
  });

  test('warns when runtimeVersion is a policy object', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await packUpdate({
        projectDir: PROJECT_DIR,
        outPath,
        skipExport: true,
        loadExpoConfig: () => loadConfig(policyRuntimeVersion),
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('policy'))).toBe(true);
  });

  test('does not warn for an explicit string runtimeVersion', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await packUpdate({
        projectDir: PROJECT_DIR,
        outPath,
        skipExport: true,
        loadExpoConfig: () => loadConfig(stringRuntimeVersion),
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(0);
  });
});
