#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';

/**
 * Package an Expo export for upload to expo-custom-ota.
 *
 * `expo export` produces `dist/`, but **not** `expoConfig.json` — and that file
 * becomes `manifest.extra.expoClient`, which is what populates
 * `Constants.expoConfig` on device. Without it, `expo-constants` reads an empty
 * config and the failure only shows up at runtime. So this script generates it
 * from `@expo/config` and zips everything together.
 *
 * Usage, from your Expo project directory:
 *
 *   bun run /path/to/oat/scripts/pack-update.ts
 *   bun run /path/to/oat/scripts/pack-update.ts --project . --out update.zip --skip-export
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const projectDir = resolve(arg('project') ?? process.cwd());
const outPath = resolve(arg('out') ?? join(projectDir, 'update.zip'));
const distDir = join(projectDir, 'dist');

if (!existsSync(join(projectDir, 'package.json'))) {
  console.error(`No package.json in ${projectDir}. Pass --project <expo-project-dir>.`);
  process.exit(1);
}

// --- 1. Export --------------------------------------------------------------
if (!flag('skip-export')) {
  console.log('Running `expo export --platform all`…');
  const proc = Bun.spawnSync(['bunx', 'expo', 'export', '--platform', 'all'], {
    cwd: projectDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0) {
    console.error('expo export failed.');
    process.exit(proc.exitCode ?? 1);
  }
} else if (!existsSync(distDir)) {
  console.error(`--skip-export was given but ${distDir} does not exist.`);
  process.exit(1);
}

// --- 2. Public Expo config --------------------------------------------------
console.log('Generating expoConfig.json…');
let expoConfigJson: string;
try {
  const { getConfig } = (await import(
    join(projectDir, 'node_modules', '@expo', 'config', 'build', 'Config.js')
  )) as typeof import('@expo/config');

  const { exp } = getConfig(projectDir, { skipSDKVersionRequirement: true, isPublicConfig: true });
  expoConfigJson = JSON.stringify(exp);

  const runtimeVersion = exp.runtimeVersion;
  if (!runtimeVersion) {
    console.warn(
      '\n⚠  No runtimeVersion in your app config. expo-custom-ota requires an explicit string ' +
        '(a policy cannot be resolved server-side). The upload will be rejected.\n',
    );
  } else if (typeof runtimeVersion === 'object') {
    console.warn(
      `\n⚠  runtimeVersion uses the "${runtimeVersion.policy}" policy. expo-custom-ota requires an explicit ` +
        'string, because the server cannot compute a policy. The upload will be rejected.\n',
    );
  } else {
    console.log(`  runtimeVersion: ${runtimeVersion}`);
  }
} catch (error) {
  console.error(
    'Could not load @expo/config from the project. Is this an Expo project with dependencies ' +
      `installed?\n  ${(error as Error).message}`,
  );
  process.exit(1);
}

// --- 3. Zip -----------------------------------------------------------------
function collect(dir: string, files: Record<string, Uint8Array> = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, files);
    } else {
      // POSIX separators: ZIP entry names always use forward slashes, and the
      // importer matches them against paths from metadata.json.
      const name = relative(distDir, full).split('\\').join('/');
      files[name] = new Uint8Array(readFileSync(full));
    }
  }
  return files;
}

const files = collect(distDir);
files['expoConfig.json'] = new TextEncoder().encode(expoConfigJson);

if (!files['metadata.json']) {
  console.error('dist/metadata.json is missing — the export did not produce a native bundle.');
  process.exit(1);
}

const archive = zipSync(files, { level: 6 });
await Bun.write(outPath, archive);

const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json']));
const platforms = Object.keys(metadata.fileMetadata ?? {});

console.log(`\n✓ ${outPath}`);
console.log(
  `  ${(archive.byteLength / 1024 / 1024).toFixed(1)} MB · ${Object.keys(files).length} files`,
);
console.log(`  platforms: ${platforms.join(', ') || '(none)'}`);
console.log(
  '\nUpload it from the expo-custom-ota dashboard: Applications → your app → Releases → Upload.',
);
