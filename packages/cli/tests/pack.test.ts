import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('packUpdate --platform and dist/ cleanup (issue 2)', () => {
  /** A project directory independent of the shared fixtures, safe for each test to mutate. */
  function makeExportProject(): string {
    const dir = join(tmpDir, 'export-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'export-project' }));
    return dir;
  }

  /** Writes just enough of a dist/ tree to look like a real `expo export` for one platform. */
  function fakeExport(dir: string, platform: string): void {
    const jsDir = join(dir, 'dist', '_expo', 'static', 'js', platform);
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(join(jsDir, 'index-abc123.hbc'), 'fake bundle');
    writeFileSync(
      join(dir, 'dist', 'metadata.json'),
      JSON.stringify({ fileMetadata: { [platform]: {} } }),
    );
  }

  test('defaults to --platform "all" when none is given', async () => {
    const projectDir = makeExportProject();
    const seenPlatforms: string[] = [];

    await packUpdate({
      projectDir,
      outPath,
      quiet: true,
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
      runExpoExport: (dir, platform) => {
        seenPlatforms.push(platform);
        fakeExport(dir, 'android');
      },
    });

    expect(seenPlatforms).toEqual(['all']);
  });

  test('forwards --platform through to the export step', async () => {
    const projectDir = makeExportProject();
    const seenPlatforms: string[] = [];

    const result = await packUpdate({
      projectDir,
      outPath,
      quiet: true,
      platform: 'android',
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
      runExpoExport: (dir, platform) => {
        seenPlatforms.push(platform);
        fakeExport(dir, 'android');
      },
    });

    expect(seenPlatforms).toEqual(['android']);
    expect(result.platforms).toEqual(['android']);
  });

  test('clears a stale dist/ before running the export, so a platform switch cannot leak the previous bundle', async () => {
    const projectDir = makeExportProject();
    // Simulate what a prior `--platform all` run left behind.
    const staleFile = join(projectDir, 'dist', '_expo', 'static', 'js', 'ios', 'index-stale.hbc');
    mkdirSync(join(projectDir, 'dist', '_expo', 'static', 'js', 'ios'), { recursive: true });
    writeFileSync(staleFile, 'stale ios bundle');

    let staleFilePresentWhenExportRan: boolean | undefined;

    await packUpdate({
      projectDir,
      outPath,
      quiet: true,
      platform: 'android',
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
      runExpoExport: (dir) => {
        staleFilePresentWhenExportRan = existsSync(staleFile);
        fakeExport(dir, 'android');
      },
    });

    expect(staleFilePresentWhenExportRan).toBe(false);
    expect(existsSync(staleFile)).toBe(false);
  });

  test('does not touch dist/ when --skip-export is given — the caller owns dist/', async () => {
    const projectDir = join(tmpDir, 'skip-export-project');
    cpSync(PROJECT_DIR, projectDir, { recursive: true });
    const staleFile = join(projectDir, 'dist', 'stale-marker.txt');
    writeFileSync(staleFile, 'left behind by the caller, on purpose');

    await packUpdate({
      projectDir,
      outPath,
      skipExport: true,
      quiet: true,
      loadExpoConfig: () => loadConfig(stringRuntimeVersion),
    });

    expect(existsSync(staleFile)).toBe(true);
  });
});
