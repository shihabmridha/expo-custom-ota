import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceMetadata } from '@ota/types';
import { unzipSync } from 'fflate';
import { packUpdate } from '../src/pack.ts';
import { publishUpdate } from '../src/publish.ts';

let projectDir: string;
let descriptor: string;
const source: SourceMetadata = {
  schemaVersion: 1,
  sourceRevision: `1.0.0+${'a'.repeat(40)}`,
  gitCommit: 'a'.repeat(40),
  application: 'xyz.fixture.mobile',
  environment: 'staging',
  platform: 'android',
  runtimeVersion: '1.0.0',
  appVersion: '1.0.0',
  nativeVersionCode: 1,
  toolchain: {
    bun: '1.4.0',
    node: 'v24.0.0',
    expo: '57.0.19',
    reactNative: '0.86.3',
    expoUpdates: '57.0.21',
  },
  publicConfigDigest: 'b'.repeat(64),
};
const config = {
  exp: {
    version: source.appVersion,
    runtimeVersion: source.runtimeVersion,
    android: { package: source.application, versionCode: source.nativeVersionCode },
  },
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'source-pack-'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'source-fixture' }));
  writeFileSync(join(projectDir, '.gitignore'), 'dist/\nupdate.zip\nrelease.json\n');
  git('init');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture');
  source.gitCommit = git('rev-parse', 'HEAD');
  source.sourceRevision = `${source.appVersion}+${source.gitCommit}`;
  descriptor = join(projectDir, 'release.json');
  writeFileSync(descriptor, JSON.stringify(source));
});
function git(...args: string[]) {
  return execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' }).trim();
}
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

const options = () => ({
  projectDir,
  releaseMetadataPath: descriptor,
  platform: 'android',
  quiet: true,
  loadExpoConfig: async () => config,
  runExpoExport: (dir: string, _platform: string, _quiet: boolean, env?: NodeJS.ProcessEnv) => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(
      join(dir, 'dist/index.hbc'),
      `globalThis.source = ${JSON.stringify(env?.EXPO_PUBLIC_SOURCE_REVISION)};`,
    );
    writeFileSync(
      join(dir, 'dist/metadata.json'),
      JSON.stringify({
        fileMetadata: {
          android: { bundle: 'index.hbc', assets: [] },
        },
      }),
    );
  },
});

test('fresh export embeds the descriptor revision and includes exactly the validated metadata', async () => {
  const packed = await packUpdate(options());
  const files = unzipSync(packed.archive);
  expect(JSON.parse(new TextDecoder().decode(files['releaseMetadata.json']))).toEqual(source);
  expect(new TextDecoder().decode(files['index.hbc'])).toContain(source.sourceRevision);
  expect(packed.sourceMetadata).toEqual(source);
});

test('does not attach new source metadata to an existing export', async () => {
  await expect(packUpdate({ ...options(), skipExport: true })).rejects.toThrow(
    'requires a fresh export',
  );
});

test('rejects descriptors for a different app, runtime, version or platform before exporting', async () => {
  for (const changes of [
    { application: 'wrong' },
    { runtimeVersion: 'wrong' },
    { nativeVersionCode: 2 },
  ]) {
    writeFileSync(descriptor, JSON.stringify({ ...source, ...changes }));
    await expect(packUpdate(options())).rejects.toThrow('does not match');
  }
  writeFileSync(descriptor, JSON.stringify(source));
  await expect(packUpdate({ ...options(), platform: 'ios' })).rejects.toThrow('does not match');
});

test('rejects a source revision exceeding the bound or containing whitespace', async () => {
  for (const sourceRevision of ['x'.repeat(129), '1.0.0 + invalid']) {
    writeFileSync(descriptor, JSON.stringify({ ...source, sourceRevision }));
    await expect(packUpdate(options())).rejects.toThrow();
  }
});

test('a descriptor cannot carry credentials as additional fields', async () => {
  writeFileSync(descriptor, JSON.stringify({ ...source, password: 'secret' }));
  await expect(packUpdate(options())).rejects.toThrow();
});

test('rejects publishing to a different environment before making any network requests', async () => {
  await expect(
    publishUpdate({
      ...options(),
      channel: 'production',
      serverUrl: 'http://127.0.0.1:1',
      appId: 'application',
      email: 'admin@example.com',
      password: 'secret',
    }),
  ).rejects.toThrow('environment does not match');
});

test('rejects source edits during export before contacting the publication server', async () => {
  const initial = options();
  await expect(
    publishUpdate({
      ...initial,
      runExpoExport: (...args) => {
        initial.runExpoExport(...args);
        writeFileSync(join(projectDir, 'package.json'), '{"name":"changed-during-export"}');
      },
      channel: 'staging',
      serverUrl: 'http://127.0.0.1:1',
      appId: 'application',
      email: 'admin@example.com',
      password: 'secret',
    }),
  ).rejects.toThrow('Source checkout must be clean');
});

test('rejects a different clean commit after export', async () => {
  const initial = options();
  await expect(
    packUpdate({
      ...initial,
      runExpoExport: (...args) => {
        initial.runExpoExport(...args);
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'new commit',
        );
      },
    }),
  ).rejects.toThrow('Source checkout must be clean');
});

test('rejects untracked source files created during export', async () => {
  const initial = options();
  await expect(
    packUpdate({
      ...initial,
      runExpoExport: (...args) => {
        initial.runExpoExport(...args);
        writeFileSync(join(projectDir, 'new-source.ts'), 'export const changed = true;');
      },
    }),
  ).rejects.toThrow('Source checkout must be clean');
});
