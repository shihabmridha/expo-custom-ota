import { Command } from 'commander';
// The version is read from the manifest rather than repeated here: the release
// workflow verifies the git tag against package.json, so that file is the one
// source of truth. The bundler inlines this, so nothing is read at runtime.
import pkg from '../package.json' with { type: 'json' };
import { packUpdate } from './pack.ts';
import { publishUpdate } from './publish.ts';

export const program = new Command();

program
  .name('expo-custom-ota')
  .description('CLI tool for packaging and publishing Expo custom OTA updates')
  .version(pkg.version);

program
  .command('pack')
  .description('Package an Expo project export into an uploadable update.zip archive')
  .option(
    '-p, --project <dir>',
    'Expo project directory (defaults to current working directory)',
    '.',
  )
  .option('-o, --out <path>', 'Output archive path (defaults to <project>/update.zip)')
  .option('--skip-export', 'Skip running `expo export` and package existing dist/ directory')
  .option('--platform <list>', 'Platforms to export: all, android, ios', 'all')
  .option('-q, --quiet', 'Suppress non-error logs')
  .action(async (options) => {
    try {
      await packUpdate({
        projectDir: options.project,
        outPath: options.out,
        skipExport: options.skipExport,
        platform: options.platform,
        quiet: options.quiet,
      });
    } catch (error) {
      console.error(`\n❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('publish')
  .description('Package an Expo export and publish directly to an expo-custom-ota server')
  .option('-p, --project <dir>', 'Expo project directory', '.')
  .option('-o, --out <path>', 'Output archive path')
  .option('--skip-export', 'Skip running `expo export`')
  .option('--platform <list>', 'Platforms to export: all, android, ios', 'all')
  .option('-s, --server <url>', 'Server URL (or set OTA_SERVER_URL)')
  .option('-a, --app <id>', 'Application ID (or set OTA_APP_ID)')
  // No Commander default here, deliberately — like its siblings above. A default
  // would make `options.channel` always set, so `publishUpdate`'s
  // `?? process.env.OTA_CHANNEL` could never be reached and the documented env
  // var would be dead. The 'production' fallback lives in publish.ts instead.
  .option(
    '-c, --channel <name>',
    'Channel to publish to (or set OTA_CHANNEL, defaults to production)',
  )
  .option('-e, --email <email>', 'Admin email (or set OTA_EMAIL)')
  .option('-w, --password <password>', 'Admin password (or set OTA_PASSWORD)')
  .option('-m, --message <message>', 'Release message / notes')
  .action(async (options) => {
    try {
      await publishUpdate({
        projectDir: options.project,
        outPath: options.out,
        skipExport: options.skipExport,
        platform: options.platform,
        serverUrl: options.server,
        appId: options.app,
        channel: options.channel,
        email: options.email,
        password: options.password,
        message: options.message,
      });
    } catch (error) {
      console.error(`\n❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Guarded so tests can import `program` to inspect its command/option definitions
// without triggering an actual parse of the test runner's own argv.
if (import.meta.main) {
  program.parse(process.argv);
}
