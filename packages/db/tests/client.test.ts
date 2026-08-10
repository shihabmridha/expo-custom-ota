import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { checkDatabaseUrl, isFileUrl, resolveFileUrl } from '../src/client.ts';

describe('checkDatabaseUrl', () => {
  test.each([
    ['libsql://localhost:8080'],
    ['libsql://127.0.0.1:8080'],
    ['libsql://[::1]:8080'],
    ['libsql://localhost'],
  ])('flags %s, which fails deep inside TLS with an unhelpful error', (url) => {
    const problem = checkDatabaseUrl(url);
    expect(problem).not.toBe(null);
    // The message has to name the fix, not just the symptom — the driver's own
    // error mentions only a certificate and an https:// URL.
    expect(problem).toContain('DATABASE_URL=http://');
    expect(problem).toContain('tls=0');
  });

  test.each([
    ['libsql://localhost:8080?tls=0', 'explicitly opts out of TLS'],
    ['http://localhost:8080', 'plain HTTP is unambiguous'],
    ['https://localhost:8080', 'caller asked for TLS deliberately'],
    ['file:./ota.db', 'local file'],
    ['libsql://oat-acadion.turso.io', 'Turso cloud genuinely has TLS'],
    ['libsql://db-org.turso.io?authToken=x', 'Turso with a token'],
  ])('allows %s (%s)', (url) => {
    expect(checkDatabaseUrl(url)).toBe(null);
  });

  test('reports an unparseable libsql URL', () => {
    expect(checkDatabaseUrl('libsql://:::::')).toContain('not a valid URL');
  });
});

describe('isFileUrl', () => {
  test.each([
    ['file:./ota.db', true],
    ['file:/data/ota.db', true],
    ['http://localhost:8080', false],
    ['libsql://db.turso.io', false],
  ])('%s -> %s', (url, expected) => {
    expect(isFileUrl(url)).toBe(expected);
  });
});

describe('resolveFileUrl', () => {
  test('resolves a relative path against the given working directory', () => {
    // Bun loads .env from cwd and `file:./ota.db` resolves from it too, so a
    // script run from a subdirectory would otherwise open a different database.
    const base = resolve('/srv/oat');
    expect(resolveFileUrl('file:./ota.db', base)).toBe(join(base, 'ota.db'));
  });

  test('leaves an absolute path alone', () => {
    const absolute = resolve('/data/ota.db');
    expect(resolveFileUrl(`file:${absolute}`, resolve('/somewhere/else'))).toBe(absolute);
  });

  test('strips the // in file://', () => {
    const base = resolve('/srv/oat');
    expect(resolveFileUrl('file://ota.db', base)).toBe(join(base, 'ota.db'));
  });
});
