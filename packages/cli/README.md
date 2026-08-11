# @shihabmridha/expo-custom-ota

Command-line interface to package and publish updates for `expo-custom-ota`.

## Installation

Requires Node 18 or newer.

This package is published to **GitHub Packages**, not npmjs.org. GitHub Packages requires an
access token to install *every* package, including public ones — this is a property of the
registry, not of this package's visibility. There is no anonymous install. Three steps:

### 1. Create a token

Go to **github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)**
and generate a token with the **`read:packages`** scope. Classic tokens are required here;
fine-grained tokens do not currently cover the packages registry.

Export it in your shell (and in CI, as a secret):

```bash
export GITHUB_TOKEN=ghp_yourtokenhere
```

Keep it in your environment, not in a committed file — the `.npmrc` below references the variable
rather than embedding the value, so the token itself never lands in your repository.

### 2. Point the scope at GitHub Packages

Add an `.npmrc` next to your Expo project's `package.json` (or to `~/.npmrc` to cover every
project on the machine):

```
@shihabmridha:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Only the `@shihabmridha` scope is redirected; everything else still resolves from npmjs.org as
normal.

If you install with Bun, use `bunfig.toml` instead:

```toml
[install.scopes]
"@shihabmridha" = { token = "$GITHUB_TOKEN", url = "https://npm.pkg.github.com/" }
```

### 3. Install

```bash
npm install --save-dev @shihabmridha/expo-custom-ota
# or
bun add -d @shihabmridha/expo-custom-ota
```

The binary installs as `expo-custom-ota`, so `npx expo-custom-ota …` works from the project root.

### If install fails

| Symptom | Cause |
| --- | --- |
| `401 Unauthorized` | `GITHUB_TOKEN` is unset, expired, or missing the `read:packages` scope. `echo $GITHUB_TOKEN` to confirm it is actually exported in the shell running npm. |
| `404 Not Found` | Either the `.npmrc` scope line is missing (npm looked on npmjs.org, where this package does not exist), or the package is still **private** — see below. |

**Maintainer note:** GitHub Packages does *not* inherit visibility from the repository. A newly
published package is private even when the source repo is public, and only the owner can install
it until that changes. After the first release, set it to public once at
**github.com/shihabmridha?tab=packages → expo-custom-ota → Package settings → Change visibility →
Public**. This cannot be automated from the workflow, and it is irreversible.

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
* `-q, --quiet`: Suppress non-error logs

### 2. Package & Publish directly (`publish`)

Package and upload directly to your `expo-custom-ota` server:

```bash
npx expo-custom-ota publish \
  --server https://ota.example.com \
  --app ota_X7jb8C49pQ2 \
  --channel production \
  --email admin@example.com \
  --password secret \
  --message "Release v1.0.1 bug fixes"
```

Or set environment variables in CI/CD:
* `OTA_SERVER_URL`
* `OTA_APP_ID`
* `OTA_CHANNEL`
* `OTA_EMAIL`
* `OTA_PASSWORD`

```bash
npx expo-custom-ota publish
```
