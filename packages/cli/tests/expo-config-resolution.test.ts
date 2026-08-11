import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLoadExpoConfig } from '../src/pack.ts';

/**
 * Issue 1 regression: `defaultLoadExpoConfig` used to hardcode
 * `<project>/node_modules/@expo/config/build/Config.js`, which does not exist in a
 * hoisted workspace — Bun's required `linker="hoisted"`, npm/yarn workspaces, and
 * pnpm `node-linker=hoisted` all keep `@expo/config` at the workspace root, and the
 * app directory has no `node_modules` of its own. It now anchors a `createRequire`
 * at the project's `package.json`, so plain Node/Bun module resolution walks UP the
 * directory tree to find it — the same way the project itself would resolve it.
 *
 * This builds that exact layout on disk (a fake CJS `@expo/config` reachable only
 * from a parent directory, and a project directory with a package.json but no
 * node_modules at all) and exercises the real resolution path, not the
 * `loadExpoConfig` test seam.
 */

let workspaceRoot: string;
let projectDir: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'hoisted-workspace-'));

  // A fake @expo/config, installed only at the workspace root — never inside the
  // project directory itself.
  const configPkgDir = join(workspaceRoot, 'node_modules', '@expo', 'config');
  mkdirSync(join(configPkgDir, 'build'), { recursive: true });
  writeFileSync(
    join(configPkgDir, 'package.json'),
    JSON.stringify({ name: '@expo/config', version: '0.0.0-test', main: 'build/index.js' }),
  );
  writeFileSync(
    join(configPkgDir, 'build', 'index.js'),
    [
      'exports.getConfig = function getConfig(dir, opts) {',
      '  return {',
      '    exp: {',
      "      runtimeVersion: '9.9.9',",
      '      resolvedProjectDir: dir,',
      '      skipSDKVersionRequirement: opts.skipSDKVersionRequirement,',
      '      isPublicConfig: opts.isPublicConfig,',
      '    },',
      '  };',
      '};',
      '',
    ].join('\n'),
  );

  // The project itself: a package.json and nothing else — no node_modules
  // directory at all, mirroring `apps/mobile` in a hoisted monorepo.
  projectDir = join(workspaceRoot, 'apps', 'mobile');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'mobile' }));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('defaultLoadExpoConfig', () => {
  test('resolves @expo/config from a parent directory when the project has no node_modules', async () => {
    const config = await defaultLoadExpoConfig(projectDir);
    expect(config.exp.runtimeVersion).toBe('9.9.9');
  });

  test('calls getConfig with the project dir and the same options as before', async () => {
    const config = await defaultLoadExpoConfig(projectDir);
    expect(config.exp.resolvedProjectDir).toBe(projectDir);
    expect(config.exp.skipSDKVersionRequirement).toBe(true);
    expect(config.exp.isPublicConfig).toBe(true);
  });

  test('still resolves when the project has its own node_modules (standalone project)', async () => {
    // A second @expo/config, this time installed directly inside the project — the
    // closer one must win, same as normal Node resolution.
    const localConfigDir = join(projectDir, 'node_modules', '@expo', 'config');
    mkdirSync(join(localConfigDir, 'build'), { recursive: true });
    writeFileSync(
      join(localConfigDir, 'package.json'),
      JSON.stringify({ name: '@expo/config', version: '0.0.0-test-local', main: 'build/index.js' }),
    );
    writeFileSync(
      join(localConfigDir, 'build', 'index.js'),
      "exports.getConfig = () => ({ exp: { runtimeVersion: 'local-1.0.0' } });\n",
    );

    const config = await defaultLoadExpoConfig(projectDir);
    expect(config.exp.runtimeVersion).toBe('local-1.0.0');
  });
});
