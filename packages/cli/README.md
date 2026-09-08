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
