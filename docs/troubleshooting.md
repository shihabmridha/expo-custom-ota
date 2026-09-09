# Troubleshooting

Keyed by what you actually see, not by subsystem.

Before anything else, try the **Simulator** tab in the dashboard. It replays a device's request
server-side and reports the selection decision, the response parts, and whether the stored
signature still verifies. Most problems below are diagnosable there in one click.

---

## The client logs "No expo-signature header specified"

The client was configured for code signing and got an unsigned response.

- The application has no active signing key → **Signing** tab → generate one, then **republish**
  the affected releases. Signing happens at import time, so existing releases stay unsigned.
- The response was a *directive* (`noUpdateAvailable` / `rollBackToEmbedded`) rather than a
  manifest. Directives must be signed too. expo-custom-ota does this; if you see it, check the server logs
  for `signing_failure`.

## The client logs "Key with keyid=… not found in client configuration"

`codeSigningMetadata.keyid` in your `app.json` does not match the `keyid` the server signed
with. expo-custom-ota uses `main` by default. Copy the snippet from **Client setup** verbatim — it contains
the correct value.

This one is unforgiving: the client rejects the update outright rather than falling back.

## "First certificate in chain is not a code signing certificate"

The certificate embedded in the app is not usable for Expo code signing. Almost always this means
an **app signing certificate** was used — your Android keystore or iOS distribution certificate.
Those are a different key with a different job; `keytool` certificates carry no
`extKeyUsage: codeSigning`, which the client requires.

Use the certificate from the application's **Signing** tab instead, and keep using your keystore
to build the binary. See the code-signing section of [client-setup.md](client-setup.md).

## A rollBackToEmbedded is deployed, but `checkForUpdateAsync` says `isAvailable: false`

That is the documented shape, not a failure. A rollback has no manifest to offer, so
`checkForUpdateAsync()` returns:

```js
{ isAvailable: false, isRollBackToEmbedded: true }
```

Custom update UI that branches only on `isAvailable` therefore ignores the kill-switch entirely —
the one mechanism you reach for when something is on fire. Handle both:

```js
const result = await Updates.checkForUpdateAsync();
if (result.isAvailable || result.isRollBackToEmbedded) {
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
}
```

The **automatic** launch flow handles directives natively and needs no application code, so a
force-stop and relaunch applies the rollback regardless. Confirm from the server side by looking
for `roll_back_to_embedded_served`.

## The signature does not verify, and the keyid is right

The signing key was rotated after the release was published. Rotation does not re-sign existing
releases. Republish, or roll back to a release signed with the current key. The Simulator
reports this explicitly.

## The device never updates, and the server logs `no_update_available`

Work through, in order:

1. **Runtime version.** The device's `expo-runtime-version` must match a deployment *exactly* —
   it is an opaque string, never compared semantically. `1.0.0` and `1.0` are different runtimes.
2. **Channel.** Devices send `expo-channel-name` via `updates.requestHeaders`. If it is absent,
   expo-custom-ota falls back to the application's default channel. Check what the device is actually
   sending.
3. **Platform.** A release with only an Android variant serves nothing to iOS.
4. **Already current.** If `expo-current-update-id` equals the deployed update id, this is
   correct behaviour — the device has it.

## The device never updates, and there is nothing in the server logs

The request is not reaching expo-custom-ota.

- `updates.url` still points at `u.expo.dev`, or at the wrong update key.
- Updates are **disabled in development builds**. Test against a release build.
- `checkAutomatically` / `fallbackToCacheTimeout` may be deferring the check. On a cold start,
  `expo-updates` typically applies an update on the *next* launch — relaunch twice.

## "This update appears to belong to another application"

The `android.package` or `ios.bundleIdentifier` in the uploaded `expoConfig.json` does not match
what the application is configured with. The error names both values. Either you uploaded to the
wrong application, or the identifiers on the **Settings** tab are wrong.

## "Archive has no expoConfig.json"

`expo export` does not produce it. Use `npx expo-custom-ota pack`, which generates it from
`@expo/config` and zips everything together. Without it, `manifest.extra.expoClient` would be
empty and `Constants.expoConfig` would be empty on device — a failure that only appears at
runtime, which is why the upload is rejected instead.

## "runtimeVersion policy … cannot be resolved by the server"

Your app config uses `runtimeVersion: { policy: "appVersion" | "fingerprint" | … }`. Policies are
resolved at native build time from the project's state; a server cannot compute one. Set an
explicit string.

## "metadata.json references … but the archive does not contain it"

The archive is incomplete. Usually this means the `dist/` directory was zipped *as a directory*
rather than its contents — entries end up as `dist/metadata.json` instead of `metadata.json`.
Use `npx expo-custom-ota pack`.

## Uploads fail with "decompression bomb" or "expands to more than …"

The archive's declared uncompressed size exceeds the configured limits. For a genuinely large
export, raise `MAX_EXTRACTED_BYTES` / `MAX_UPLOAD_BYTES`. If you did not expect a large export,
inspect the archive — the check exists because a malicious one can exhaust memory.

## Assets 404 after moving the server

`OTA_PUBLIC_URL` is baked into signed manifests as the asset URL prefix. Changing the domain
after publishing leaves old manifests pointing at the old host — and they cannot simply be
edited, because that would invalidate their signatures. Republish the affected releases.

## Hash or signature tests fail on a fresh Windows clone

Check `.gitattributes` is intact. Test fixtures are marked `-text -diff` because Git's line
ending conversion would rewrite them on checkout, changing their SHA-256. The symptom looks
exactly like a crypto bug.

## `openssl` interop tests skip

On Windows, openssl ships with Git but is not on the PowerShell PATH. The tests look in
`C:\Program Files\Git\usr\bin\openssl.exe` and skip loudly if it is missing. Set `OPENSSL_BIN`
to point at it.

## Login fails with "no such table: admins"

The server is pointed at a different database than the one you migrated — almost always an empty
one it created itself.

Check the startup line: it reports which database was resolved. If it says a `file:` path you
did not expect, something ran the server from the wrong directory: `config/env.ts` resolves
`DATABASE_URL` against `process.cwd()`, with no repo-root anchoring, so a `file:` path resolves
relative to wherever the process was started, and Bun only auto-loads `.env` from that same cwd.

```bash
bun run dev                       # correct: scripts/dev.ts spawns the API from the repo root
bun run dev:api                   # correct
cd backend && bun src/server.ts   # wrong: cwd is backend/, not the repo root — .env and
                                   # relative paths resolve against the wrong directory
```

Delete any stray `backend/ota.db`, then `bun run db:migrate` from the repo root. The server now
refuses to start against an unmigrated database rather than failing on the first login.

## Login returns 429

Five failed attempts per 15 minutes per IP+email. argon2id costs roughly 100 ms of CPU per
verify, so the limit is a denial-of-service defence, not a policy. It resets on restart; wait or
restart the server.

## Deleting a channel fails with "still has deployments"

Devices configured for that channel would stop receiving updates. Remove or repoint the
deployments first.

## Device metrics look incomplete

The Devices page reports retained OTA observations, not a census of installations. Its active
adoption denominator includes only matching channel/platform/runtime installs seen within the
selected window. User-ID fallback records are counted separately. The list shares these filters;
user and device-fact filters affect only the list. The history panel is application-wide.
Unknown current update IDs remain in the denominator. “Served without observed confirmation”
can mean a pending download, a client that has not checked in again, or a failure; it is not a
failure count. “Last observed running” always describes the latest check-in, not live state.

Retention defaults to 90 days and is applied by `prune:devices`; configuring retention alone
does not schedule that script. Inactivity buckets can shrink after pruning. Retention of zero
keeps records indefinitely. No historical snapshots or uninstall estimates are collected.

Look for `tracking_write_failed` warnings at the default info log level. Each includes a
`category` (`usage` or `device`), the current failing `applicationId`, and `suppressedFailures`
since the last warning. Warnings appear immediately, then on the next failure at least one
minute later. Throttling is per category across the server instance, resets on restart, and
does not coordinate across instances. Suppressed counts may span applications and are not
per-application totals. Raw database errors and client data are omitted. Check migrations,
database availability, disk space, and filesystem permissions. Tracking failure never changes
an OTA response; use these warnings to distinguish missing telemetry from absent traffic.
