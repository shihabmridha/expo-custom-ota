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

function platformOption(commandName: string) {
  const command = program.commands.find((c) => c.name() === commandName);
  if (!command) throw new Error(`no such command registered: ${commandName}`);
  return command.options.find((o) => o.long === '--platform');
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
