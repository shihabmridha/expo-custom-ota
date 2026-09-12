# expo-custom-ota

Command-line interface to package and publish updates for `expo-custom-ota`.

## Installation

Requires Node 18 or newer.

Run directly from your Expo project directory:

```bash
npx expo-custom-ota@latest --help
# or
bunx expo-custom-ota@latest --help
```

Or install locally:

```bash
npm install --save-dev expo-custom-ota
# or
bun add -d expo-custom-ota
```

## Publishing the CLI

Set a new version in `packages/cli/package.json`, then publish from that directory:

```bash
cd packages/cli
npm publish --access public
```

The `prepack` script builds the CLI before packaging. Publishing is manual; CI does
not publish packages to npm.

## Usage

### 1. Package an update (`pack`)

Run from your Expo project root to generate `update.zip`:

```bash
npx expo-custom-ota pack
```

Options:
* `-p, --project <dir>`: Expo project directory (default `.`)
* `-o, --out <path>`: Output ZIP path (default `<project>/update.zip`)
* `--skip-export`: Skip running `expo export` and package an existing `dist/` folder
* `--release-metadata <path>`: Embed the descriptor's source revision during a fresh Android export and include `releaseMetadata.json` in the archive; cannot be combined with `--skip-export`
* `--platform <list>`: Platforms to export: `all`, `android`, `ios` (default `all`)
* `-q, --quiet`: Suppress non-error logs

### 2. Package & Publish directly (`publish`)

Package and upload directly to your `expo-custom-ota` server:

```bash
npx expo-custom-ota publish \
  --server https://ota.example.com \
  --app 8030e416-fb8b-4bac-ada6-e76b1b31881a \
  --channel production \
  --email admin@example.com \
  --password secret \
  --message "Release v1.0.1 bug fixes"
```

Or set environment variables in CI/CD:
* `OTA_SERVER_URL`
* `OTA_APP_ID` — the application UUID (not the `ota_…` update key in your updates URL)
* `OTA_CHANNEL`
* `OTA_EMAIL`
* `OTA_PASSWORD`

```bash
npx expo-custom-ota publish
```

### Source release grouping (0.1.3)

Both `pack` and `publish` accept `--release-metadata <path>`. The versioned
descriptor contract is `sourceMetadataSchema` in `@ota/contracts`. It includes
`sourceRevision` (`appVersion+gitCommit`), application package, environment,
platform, runtime and native versions, toolchain versions, and a SHA-256 public
configuration digest. Descriptors must not contain credentials or extra fields.

The CLI checks descriptor application/version/runtime against Expo config and
inlines `EXPO_PUBLIC_SOURCE_REVISION` into the fresh export. `publish` also checks
the descriptor environment against its destination channel before contacting the
server. The CLI requires a clean Git checkout at the descriptor's commit before
export and checks it again after assembling the archive, before writing it or
contacting the server. Source edits, new untracked files, and commit changes abort
publication. Keep generated output, the output ZIP, and local descriptors
gitignored. The application's release script owns effective configuration and
toolchain verification; arbitrary existing exports cannot acquire a descriptor
through `--skip-export`.

Deploy server migration `0004_source_release_metadata` and its API changes before
using this CLI version or the updated dashboard. Package publication is manual.
Legacy archives without metadata continue to work.
