# Publishing

## The normal flow

```
change JS  →  pack-update.ts  →  upload  →  publish to staging  →  test  →  promote to production
```

### 1. Package

From your Expo project:

```bash
bun run /path/to/oat/scripts/pack-update.ts
```

This runs `expo export --platform all`, generates `expoConfig.json` (which `expo export` does
not produce), and writes `update.zip`.

`expoConfig.json` matters: it becomes `manifest.extra.expoClient`, which is what populates
`Constants.expoConfig` on device. An archive without it is rejected rather than accepted with an
empty config, because the latter fails silently at runtime.

### 2. Upload

**Applications → your app → Releases → Upload.** The upload returns immediately and the import
runs in the background; the screen polls until it finishes.

The importer validates the archive, checks the native identifiers against the application,
hashes every file, deduplicates against existing assets, uploads only what is new, and builds
and signs one manifest per platform. It ends as a **draft**.

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
