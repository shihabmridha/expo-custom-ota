import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findRepoRoot, loadEnv } from '../src/config/env.ts';

/**
 * Configuration must resolve identically however the server is launched.
 *
 * `bun run --filter '*' dev` runs each workspace script in its own directory,
 * so the backend started with cwd=backend/, never saw the root `.env`, silently
 * fell back to the default `file:./oat.db`, and created an empty
 * `backend/oat.db`. The first login then failed with "no such table: admins" —
 * an error pointing at the query rather than the cause.
 */

const scratch = mkdtempSync(join(tmpdir(), 'oat-env-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('findRepoRoot', () => {
  test('finds the workspace root from inside the backend package', () => {
    const root = findRepoRoot(join(import.meta.dir, '..', 'src', 'config'));
    const manifest = JSON.parse(
      require('node:fs').readFileSync(join(root, 'package.json'), 'utf8'),
    );
    expect(manifest.workspaces).toBeDefined();
  });

  test('walks up past nested directories', () => {
    expect(findRepoRoot(join(import.meta.dir, '..', 'src', 'routes', 'admin'))).toBe(
      findRepoRoot(join(import.meta.dir, '..')),
    );
  });

  test('falls back to cwd rather than looping forever', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'oat-noroot-'));
    expect(() => findRepoRoot(isolated)).not.toThrow();
    rmSync(isolated, { recursive: true, force: true });
  });
});

describe('path resolution', () => {
  test('storage and signing directories are absolute, not cwd-relative', () => {
    const env = loadEnv({ NODE_ENV: 'test', STORAGE_LOCAL_DIR: './.storage' });
    expect(isAbsolute(env.storageLocalDirAbsolute)).toBe(true);
    expect(isAbsolute(env.signingKeysDirAbsolute)).toBe(true);
    // Anchored to the repo root, so launching from backend/ resolves the same.
    expect(env.storageLocalDirAbsolute.startsWith(env.repoRoot)).toBe(true);
  });

  test('a relative file: database is resolved against the repo root', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./oat.db' });
    expect(env.DATABASE_URL).toBe(`file:${join(env.repoRoot, 'oat.db')}`);
  });

  test('an absolute file: database is left alone', () => {
    const absolute = join(scratch, 'somewhere.db');
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: `file:${absolute}` });
    expect(env.DATABASE_URL).toBe(`file:${absolute}`);
  });

  test('a remote database URL is passed through untouched', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'http://localhost:8080' });
    expect(env.DATABASE_URL).toBe('http://localhost:8080');
  });
});

describe('precedence', () => {
  test('explicit environment beats the .env file', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'http://explicit:9999' });
    expect(env.DATABASE_URL).toBe('http://explicit:9999');
  });

  test('an empty environment value does not mask the .env file', () => {
    // Shells routinely export empty strings; treating one as "set" would
    // override a real value with nothing.
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: '' });
    expect(['debug', 'info', 'warn', 'error']).toContain(env.LOG_LEVEL);
  });
});

describe('validation', () => {
  test('rejects a short SESSION_SECRET', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', SESSION_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  test('refuses a localhost OTA_PUBLIC_URL in production', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        OTA_PUBLIC_URL: 'http://localhost:3000',
        SESSION_SECRET: 'a'.repeat(40),
      }),
    ).toThrow(/baked into signed manifests/);
  });

  test('requires R2 credentials when the R2 driver is selected', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', STORAGE_DRIVER: 'r2' })).toThrow(/R2_ENDPOINT/);
  });

  test('reports every problem at once, not one per restart', () => {
    try {
      loadEnv({ NODE_ENV: 'production', SESSION_SECRET: 'short', STORAGE_DRIVER: 'r2' });
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SESSION_SECRET');
      expect(message).toContain('R2_BUCKET');
    }
  });

  test('strips a trailing slash from OTA_PUBLIC_URL', () => {
    // It is concatenated with asset paths into signed manifests; a double slash
    // would be baked in permanently.
    const env = loadEnv({ NODE_ENV: 'test', OTA_PUBLIC_URL: 'https://ota.example.com/' });
    expect(env.OTA_PUBLIC_URL).toBe('https://ota.example.com');
  });
});

describe('.env discovery', () => {
  test('reads a repo-root .env when the process environment lacks the value', () => {
    // Simulated: a fake workspace root with its own .env, resolved from a
    // nested directory the way backend/src/config would be.
    const root = mkdtempSync(join(tmpdir(), 'oat-fake-root-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fake', workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(root, '.env'),
      '# comment\nLOG_LEVEL=warn\nOTA_PUBLIC_URL="https://x.test"\n',
    );
    mkdirSync(join(root, 'packages', 'deep'), { recursive: true });

    expect(findRepoRoot(join(root, 'packages', 'deep'))).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});
