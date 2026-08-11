# Publishing

## The normal flow

```
change JS  →  expo-custom-ota pack  →  upload  →  publish to staging  →  test  →  promote to production
```

There are two ways to get a release from your Expo project onto the server: package locally and
upload through the dashboard (below), or use the CLI's `publish` command, which does both steps
in one call.

### 1. Package

Install the CLI as a dev dependency in your Expo project. It is published to GitHub Packages,
which requires a `read:packages` token to install even public packages, so this needs an
`.npmrc` as well as the install itself:

```
@shihabmridha:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
export GITHUB_TOKEN=ghp_yourtokenhere
npm install --save-dev @shihabmridha/expo-custom-ota
```

Full setup, including how to create the token and what a 401 or 404 means, is in
[`packages/cli/README.md`](../packages/cli/README.md) — that file is the canonical install guide
and ships with the package itself.

Then, from your Expo project:

```bash
npx expo-custom-ota pack
```

This runs `expo export --platform all`, generates `expoConfig.json` (which `expo export` does
not produce), and writes `update.zip`.

`expoConfig.json` matters: it becomes `manifest.extra.expoClient`, which is what populates
`Constants.expoConfig` on device. An archive without it is rejected rather than accepted with an
empty config, because the latter fails silently at runtime.

### 2. Upload

Either **Applications → your app → Releases → Upload** in the dashboard, or from the CLI:

```bash
npx expo-custom-ota publish \
  --server https://ota.example.com --app <application-id> --channel production \
  --email you@example.com --password '<a long password>'
```

`publish` runs `pack` and the upload in one step, then publishes the resulting release to the
given channel. Either way, the upload returns immediately and the import runs in the background;
the dashboard screen polls until it finishes, and the CLI waits for it before publishing.

The importer validates the archive, checks the native identifiers against the application,
hashes every file, deduplicates against existing assets, uploads only what is new, and builds
and signs one manifest per platform. It ends as a **draft** before `publish` points a channel at
it.

If it fails, the error says what and why, and the release stays unpublishable.

### 3. Publish to staging

Open the release and publish it to `staging`. This creates deployment mappings — one per
platform variant — for that channel and runtime version.

Importing and publishing are separate on purpose: a bad import should never be able to reach
devices.

### 4. Promote

Once staging looks right, **Promote** staging → production. Promotion re-points the production
deployments at the *same* release variants. Nothing is rebuilt, re-signed or re-uploaded, so
what reaches production is byte-identical to what you tested — same `update_id`, same manifest,
same signature.

Promotion refuses if the release is not actually deployed to the source channel, since promoting
something never tested would defeat the point.

## Rolling back

**Roll back to this release** on any earlier release creates a **new** release with those
contents and publishes it. It gets a new `update_id`, `createdAt`, manifest and signature, while
referencing the same immutable assets — nothing is re-uploaded.

Clients are never pointed backwards at an old update id. That matters because `expo-updates`
selects the most recent update it has seen; handing it an older id can leave devices in an
inconsistent state.

History looks like:

```
#42  Stable
#43  Feature
#44  Broken
#45  Rollback to #42     ← new identity, #42's contents
```

## The kill-switch

Rollback only helps devices that check in *after* you publish it. For devices already running a
bad update, use **Deployments → Roll back to embedded**.

This deploys a `rollBackToEmbedded` directive telling clients to discard downloaded updates and
run the bundle embedded in their binary — the version that shipped through the app store. It is
the only mechanism that un-ships an update without publishing new JavaScript.

The client honours it only if it reports an `expo-embedded-update-id`; otherwise expo-custom-ota degrades to
`noUpdateAvailable` rather than serving something the device cannot act on.

Publishing a normal release to the same target clears the directive.

## Channels

Channels are per-application: `Acadion.production` and `Lekho.production` are unrelated rows.
`production` and `staging` are created with every application.

A channel is just a name a device asks for. Use as many as you like — `beta`, `qa`, per-tester
channels — but remember each is a separate deployment target per platform and runtime version.

## Immutability

Once published, a release's `update_id`, manifest, signature, assets and timestamps never
change. To change content, make a new release. Published releases can be archived; only drafts
can be deleted, and only when nothing is deploying them.

## Concurrency

Two people publishing different releases to the same channel, platform and runtime version at
the same time is safe: every deployment write is an upsert against a unique constraint, so
exactly one mapping survives and both attempts are recorded in the deployment history.
