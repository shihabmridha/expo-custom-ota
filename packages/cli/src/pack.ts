import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';

/**
 * Package an Expo export into an uploadable archive.
 *
 * `expo export` produces `dist/`, but **not** `expoConfig.json` — and that file
 * becomes `manifest.extra.expoClient`, which is what populates
 * `Constants.expoConfig` on device. Without it, `expo-constants` reads an empty
 * config and the failure only shows up at runtime. So this generates it from
 * `@expo/config` and zips everything together.
 */

export interface ExpoPublicConfig {
  exp: Record<string, unknown> & {
    runtimeVersion?: string | { policy: string };
  };
}

export interface PackOptions {
  projectDir?: string;
  outPath?: string;
  skipExport?: boolean;
  quiet?: boolean;
  /**
   * Platforms to pass to `expo export --platform`. Defaults to `'all'`.
   */
  platform?: string;
  /**
   * Overrides how the project's public Expo config is loaded, in place of the
   * default `@expo/config` require. Exists for tests, which run against
   * a static fixture with no `@expo/config` installed (or `node_modules` at
   * all) — real callers never need to pass this.
   */
  loadExpoConfig?: (projectDir: string) => Promise<ExpoPublicConfig>;
  /**
   * Overrides how `expo export` itself is invoked, in place of the default
   * `npx expo export` subprocess. Exists for tests — which cannot assume a
   * real Expo project or a network-reachable `npx` — real callers never need
   * to pass this.
   */
  runExpoExport?: (projectDir: string, platform: string, quiet: boolean) => void;
}

export interface PackResult {
  outPath: string;
  byteLength: number;
  fileCount: number;
  platforms: string[];
  archive: Uint8Array;
}

/** The real `@expo/config` loader, resolved the way the project itself would resolve it. */
export async function defaultLoadExpoConfig(projectDir: string): Promise<ExpoPublicConfig> {
  // Anchored at the project's package.json so resolution walks UP the node_modules
  // chain. Hoisted workspaces keep @expo/config at the repo root, and the app
  // directory may have no node_modules of its own.
  const requireFromProject = createRequire(join(projectDir, 'package.json'));
  const { getConfig } = requireFromProject('@expo/config') as {
    getConfig: (
      dir: string,
      opts: { skipSDKVersionRequirement: boolean; isPublicConfig: boolean },
    ) => ExpoPublicConfig;
  };
  return getConfig(projectDir, { skipSDKVersionRequirement: true, isPublicConfig: true });
}

/** The real `expo export` invocation, run as the target project's own `npx` would run it. */
function defaultRunExpoExport(projectDir: string, platform: string, quiet: boolean): void {
  const proc = spawnSync('npx', ['expo', 'export', '--platform', platform], {
    cwd: projectDir,
    stdio: quiet ? 'ignore' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (proc.status !== 0) {
    throw new Error(`expo export failed with exit code ${proc.status ?? 1}`);
  }
}

export async function packUpdate(options: PackOptions = {}): Promise<PackResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const outPath = resolve(options.outPath ?? join(projectDir, 'update.zip'));
  const distDir = join(projectDir, 'dist');
  const quiet = options.quiet ?? false;
  const platform = options.platform ?? 'all';
  const loadExpoConfig = options.loadExpoConfig ?? defaultLoadExpoConfig;
  const runExpoExport = options.runExpoExport ?? defaultRunExpoExport;

  if (!existsSync(join(projectDir, 'package.json'))) {
    throw new Error(`No package.json found in ${projectDir}. Pass --project <expo-project-dir>.`);
  }

  // --- 1. Export --------------------------------------------------------------
  if (!options.skipExport) {
    if (!quiet) console.log(`Running \`expo export --platform ${platform}\`…`);
    // `expo export` does not clear its own output — without this, switching from
    // `--platform all` to `--platform android` would leave the previous iOS bundle
    // sitting in dist/, and the archive below would advertise a platform it no
    // longer has a current bundle for. Only do this when we own the export; with
    // --skip-export the caller owns dist/.
    rmSync(distDir, { recursive: true, force: true });
    runExpoExport(projectDir, platform, quiet);
  } else if (!existsSync(distDir)) {
    throw new Error(`--skip-export was given but ${distDir} does not exist.`);
  }

  // --- 2. Public Expo config --------------------------------------------------
  if (!quiet) console.log('Generating expoConfig.json…');
  let expoConfigJson: string;
  try {
    const { exp } = await loadExpoConfig(projectDir);
    expoConfigJson = JSON.stringify(exp);

    const runtimeVersion = exp.runtimeVersion;
    if (!runtimeVersion) {
      if (!quiet) {
        console.warn(
          '\n⚠  No runtimeVersion in your app config. expo-custom-ota requires an explicit string ' +
            '(a policy cannot be resolved server-side). The upload will be rejected.\n',
        );
      }
    } else if (typeof runtimeVersion === 'object') {
      if (!quiet) {
        console.warn(
          `\n⚠  runtimeVersion uses the "${runtimeVersion.policy}" policy. expo-custom-ota requires an explicit ` +
            'string, because the server cannot compute a policy. The upload will be rejected.\n',
        );
      }
    } else {
      if (!quiet) console.log(`  runtimeVersion: ${runtimeVersion}`);
    }
  } catch (error) {
    throw new Error(
      'Could not load @expo/config from the project. Is this an Expo project with dependencies installed?\n  ' +
        (error as Error).message,
    );
  }

  // --- 3. Zip -----------------------------------------------------------------
  function collect(
    dir: string,
    files: Record<string, Uint8Array> = {},
  ): Record<string, Uint8Array> {
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
    throw new Error('dist/metadata.json is missing — the export did not produce a native bundle.');
  }

  const archive = zipSync(files, { level: 6 });
  writeFileSync(outPath, archive);

  const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json']));
  const platforms = Object.keys(metadata.fileMetadata ?? {});
  const fileCount = Object.keys(files).length;
  const byteLength = archive.byteLength;

  if (!quiet) {
    console.log(`\n✓ ${outPath}`);
    console.log(`  ${(byteLength / 1024 / 1024).toFixed(1)} MB · ${fileCount} files`);
    console.log(`  platforms: ${platforms.join(', ') || '(none)'}`);
    console.log('\nUpload it from the expo-custom-ota dashboard or run `expo-custom-ota publish`.');
  }

  return {
    outPath,
    byteLength,
    fileCount,
    platforms,
    archive,
  };
}
