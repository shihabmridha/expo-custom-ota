import { describe, expect, test } from 'bun:test';
import { program } from '../src/cli.ts';

/**
 * Static introspection of the Commander program definition. Importing `cli.ts`
 * does not invoke `program.parse()` — that call is guarded by `import.meta.main`,
 * which is false for a module reached via import rather than run directly — so
 * this never triggers a real `pack`/`publish` action or touches the network.
 *
 * Issue 2: both `pack` and `publish` must expose `--platform`, defaulting to
 * `'all'`.
 */

function command(commandName: string) {
  const found = program.commands.find((c) => c.name() === commandName);
  if (!found) throw new Error(`no such command registered: ${commandName}`);
  return found;
}

function platformOption(commandName: string) {
  return command(commandName).options.find((o) => o.long === '--platform');
}

describe('cli --platform option', () => {
  test('is registered on `pack`, defaulting to "all"', () => {
    const option = platformOption('pack');
    expect(option).toBeDefined();
    expect(option?.defaultValue).toBe('all');
  });

  test('is registered on `publish`, defaulting to "all"', () => {
    const option = platformOption('publish');
    expect(option).toBeDefined();
    expect(option?.defaultValue).toBe('all');
  });
});

/**
 * `--channel` must NOT carry a Commander default. Commander applies a declared
 * default into `opts()` the moment the option is registered, so a default here
 * would make `options.channel` always truthy and `publishUpdate`'s
 * `options.channel ?? process.env.OTA_CHANNEL ?? 'production'` chain could never
 * reach `OTA_CHANNEL` — the env var the README documents for CI. The
 * 'production' default lives in publish.ts, which is where cli-options.test.ts
 * covers the rest of the chain (OTA_CHANNEL, then 'production').
 *
 * These use `parseOptions`, which fills in option values without running the
 * command's action, so no packing or network work is triggered. It mutates the
 * shared `program`, so the unparsed assertions come first.
 */
describe('cli --channel option on `publish`', () => {
  test('is registered, with no Commander default', () => {
    const option = command('publish').options.find((o) => o.long === '--channel');
    expect(option).toBeDefined();
    expect(option?.defaultValue).toBeUndefined();
  });

  test('contributes no value when the flag is absent, leaving OTA_CHANNEL reachable', () => {
    // Contrast with --project/--platform, whose defaults are genuine and are
    // expected to show up here.
    expect(command('publish').opts()).toEqual({ project: '.', platform: 'all' });
  });

  test('passes an explicit flag value through as options.channel', () => {
    const publish = command('publish');
    publish.parseOptions(['--channel', 'preview']);
    expect(publish.opts().channel).toBe('preview');
  });
});
