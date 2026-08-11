import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadEnv } from '../src/config/env.ts';

const scratch = mkdtempSync(join(tmpdir(), 'ota-env-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('path resolution', () => {
  test('storage and signing directories are absolute, not cwd-relative', () => {
    const env = loadEnv({ NODE_ENV: 'test', STORAGE_LOCAL_DIR: './.storage' });
    expect(isAbsolute(env.storageLocalDirAbsolute)).toBe(true);
    expect(isAbsolute(env.signingKeysDirAbsolute)).toBe(true);
  });

  test('a relative file: database is resolved against cwd', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./ota.db' });
    expect(env.DATABASE_URL).toBe(`file:${resolve(process.cwd(), 'ota.db')}`);
  });

  test('an absolute file: database is left alone', () => {
    const absolute = join(scratch, 'somewhere.db');
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: `file:${absolute}` });
    expect(env.DATABASE_URL).toBe(`file:${absolute}`);
  });
});

describe('precedence & empty string handling', () => {
  test('explicit environment beats defaults', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./explicit.db' });
    expect(env.DATABASE_URL).toBe(`file:${resolve(process.cwd(), 'explicit.db')}`);
  });

  test('an empty environment value falls back to default', () => {
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

  test('reports every problem at once', () => {
    try {
      loadEnv({
        NODE_ENV: 'production',
        SESSION_SECRET: 'short',
        OTA_PUBLIC_URL: 'http://localhost:3000',
      });
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SESSION_SECRET');
      expect(message).toContain('OTA_PUBLIC_URL');
    }
  });

  test('strips a trailing slash from OTA_PUBLIC_URL', () => {
    const env = loadEnv({ NODE_ENV: 'test', OTA_PUBLIC_URL: 'https://ota.example.com/' });
    expect(env.OTA_PUBLIC_URL).toBe('https://ota.example.com');
  });
});
