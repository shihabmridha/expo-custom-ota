import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { isFileUrl, resolveFileUrl } from '../src/client.ts';

describe('isFileUrl', () => {
  test.each([
    ['file:./ota.db', true],
    ['file:/data/ota.db', true],
    [':memory:', true],
    ['ota.db', false],
  ])('%s -> %s', (url, expected) => {
    expect(isFileUrl(url)).toBe(expected);
  });
});

describe('resolveFileUrl', () => {
  test('resolves a relative path against the given working directory', () => {
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

  test('handles :memory:', () => {
    expect(resolveFileUrl(':memory:')).toBe(':memory:');
  });
});
