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
  manifest. Directives must be signed too. OAT does this; if you see it, check the server logs
  for `signing_failure`.

## The client logs "Key with keyid=… not found in client configuration"

`codeSigningMetadata.keyid` in your `app.json` does not match the `keyid` the server signed
with. OAT uses `main` by default. Copy the snippet from **Client setup** verbatim — it contains
the correct value.

This one is unforgiving: the client rejects the update outright rather than falling back.

## The signature does not verify, and the keyid is right

The signing key was rotated after the release was published. Rotation does not re-sign existing
releases. Republish, or roll back to a release signed with the current key. The Simulator
reports this explicitly.

## The device never updates, and the server logs `no_update_available`

Work through, in order:

1. **Runtime version.** The device's `expo-runtime-version` must match a deployment *exactly* —
   it is an opaque string, never compared semantically. `1.0.0` and `1.0` are different runtimes.
2. **Channel.** Devices send `expo-channel-name` via `updates.requestHeaders`. If it is absent,
   OAT falls back to the application's default channel. Check what the device is actually
   sending.
3. **Platform.** A release with only an Android variant serves nothing to iOS.
4. **Already current.** If `expo-current-update-id` equals the deployed update id, this is
   correct behaviour — the device has it.

## The device never updates, and there is nothing in the server logs

The request is not reaching OAT.

- `updates.url` still points at `u.expo.dev`, or at the wrong update key.
- Updates are **disabled in development builds**. Test against a release build.
- `checkAutomatically` / `fallbackToCacheTimeout` may be deferring the check. On a cold start,
  `expo-updates` typically applies an update on the *next* launch — relaunch twice.

## "This update appears to belong to another application"

The `android.package` or `ios.bundleIdentifier` in the uploaded `expoConfig.json` does not match
what the application is configured with. The error names both values. Either you uploaded to the
wrong application, or the identifiers on the **Settings** tab are wrong.

## "Archive has no expoConfig.json"

`expo export` does not produce it. Use `scripts/pack-update.ts`, which generates it from
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
Use `scripts/pack-update.ts`.

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

## `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` on a database command

```
TypeError: unknown certificate verification error
  path: "https://localhost:8080/v2/pipeline"
```

`DATABASE_URL` uses `libsql://` against a local server. The libSQL client treats `libsql://` as
TLS-required and rewrites it to `https://`, but `turso dev` / `sqld` serves plain HTTP.

```bash
DATABASE_URL=http://localhost:8080          # preferred
DATABASE_URL=libsql://localhost:8080?tls=0  # or opt out explicitly
```

`libsql://` is correct for Turso cloud. See [turso.md](turso.md).

## Login fails with "no such table: admins"

The server is pointed at a different database than the one you migrated — almost always an empty
one it created itself.

Check the startup line: it reports which database was resolved. If it says a `file:` path you
did not expect, something ran the server from the wrong directory, so Bun never loaded the root
`.env` and `DATABASE_URL` fell back to its default.

```bash
bun run dev        # correct: scripts/dev.ts spawns the API from the repo root
bun run dev:api    # correct
cd backend && bun src/server.ts   # env is still resolved from the repo root, but prefer the above
```

Delete any stray `backend/oat.db`, then `bun run db:migrate`. The server now refuses to start
against an unmigrated database rather than failing on the first login.

## Login returns 429

Five failed attempts per 15 minutes per IP+email. argon2id costs roughly 100 ms of CPU per
verify, so the limit is a denial-of-service defence, not a policy. It resets on restart; wait or
restart the server.

## Deleting a channel fails with "still has deployments"

Devices configured for that channel would stop receiving updates. Remove or repoint the
deployments first.
