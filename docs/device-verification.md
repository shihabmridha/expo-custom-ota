# Phase 12 — real-device verification

The last gate. Until this passes on a physical device, OAT is pre-production.

Everything below is prepared except the two steps only you can do: deploying to the VPS and
building the APK.

---

## The ordering that matters

**The code signing certificate is embedded in the binary.** So the certificate must exist
*before* you build, which means the server and the application must exist before you build too.
Getting this order wrong means rebuilding.

```
1. Deploy OAT to ota.acadion.xyz
2. Create the application in the dashboard   ← produces updateKey + certificate
3. Paste both into e2e/expo-test-app         ← certificate goes in certs/certificate.pem
4. Build and install the APK                 ← VERSION A ships inside the binary
5. Only now publish updates B, C, …
```

If you rotate the signing key after step 4, the installed binary can never accept another
update — its embedded certificate no longer matches. That would mean a new APK.

---

## 1. Deploy the server

On the VPS:

```bash
git clone <repo> oat && cd oat
export OTA_PUBLIC_URL=https://ota.acadion.xyz
export SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up -d
docker compose exec oat bun run backend/scripts/create-admin.ts \
  --email you@acadion.xyz --password '<a long password>'
```

Put a TLS-terminating reverse proxy in front on `:443` → `:3000`. Two settings matter:

- `client_max_body_size 512m;` (or your `MAX_UPLOAD_BYTES`) — release archives are large.
- The proxy must **not** rewrite request or response bodies. Manifest signatures are over exact
  bytes; any re-encoding breaks verification.

Confirm before continuing:

```bash
curl -s https://ota.acadion.xyz/health     # {"ok":true,"db":true,"storage":true}
```

`OTA_PUBLIC_URL` is baked into every signed manifest as the asset URL prefix. It is now fixed —
changing it later requires republishing everything.

## 2. Create the application

In the dashboard at `https://ota.acadion.xyz`:

- **Name:** OAT E2E
- **Slug:** `oat-e2e`
- **Android package:** `xyz.acadion.oate2e`
- **iOS bundle identifier:** `xyz.acadion.oate2e`
- Leave **Generate a code signing key** checked.

The identifiers must match `e2e/expo-test-app/app.json` exactly, or uploads are rejected with an
identity mismatch — which is the check working, but confusing if unexpected.

## 3. Wire up the test app

From **Client setup**, copy the update key into `app.json`:

```jsonc
"url": "https://ota.acadion.xyz/api/v1/updates/ota_XXXXXXXX"   // replace REPLACE_WITH_UPDATE_KEY
```

From **Signing**, copy the certificate into `e2e/expo-test-app/certs/certificate.pem`. It is a
public certificate and belongs in version control; the private key stays on the server.

Sanity-check before building — this catches nearly everything the device would:

```bash
# Should be 200 with a noUpdateAvailable directive (nothing published yet).
curl -sS -H "Accept: multipart/mixed" -H "Expo-Platform: android" \
  -H "Expo-Protocol-Version: 1" -H "Expo-Runtime-Version: 1.0.0" \
  -H "expo-channel-name: production" \
  https://ota.acadion.xyz/api/v1/updates/ota_XXXXXXXX
```

## 4. Build and install (your step)

```bash
cd e2e/expo-test-app
bun install
bunx expo prebuild --clean
bunx expo run:android --variant release
```

**It must be a release build.** `expo-updates` is inert in debug builds, so a debug APK will
never fetch anything and will look like a server problem.

Requirements: Android SDK, and **JDK 17 or 21** — the Android Gradle Plugin does not support
Java 26, which is what is installed on the machine I checked.

If you prefer the cloud: `bunx eas build --platform android --profile preview` produces an
installable APK without a local SDK. That uses EAS *Build*, which is unrelated to EAS *Update* —
updates still come from OAT.

Install it, launch it, and confirm it shows **VERSION A** with `isEmbeddedLaunch: true`.

## 5. Publishing a new version

```bash
cd e2e/expo-test-app
# edit App.tsx:  const VERSION = 'B';
bun run pack                    # runs expo export + generates expoConfig.json + zips
```

Upload `update.zip` from **Releases → Upload**, then publish to `production`.

On the device: tap **Check for update**, or background and relaunch. `expo-updates` applies an
update on the *next* launch, so **relaunch twice** — the first launch downloads, the second runs
it. This trips people up constantly.

---

## The checklist

Run every step. A skipped one is the one that would have failed.

| # | Step | Expect |
|---|---|---|
| 1 | Install the release APK | **VERSION A**, `isEmbeddedLaunch: true` |
| 2 | Publish **B** → relaunch twice | **VERSION B**; server logs `update_served` |
| 3 | Relaunch again | Server returns `noUpdateAvailable`; request carries `expo-current-update-id` equal to the deployed update id |
| 4 | Publish **C** → relaunch twice | **VERSION C** |
| 5 | Roll back to the **B** release | **VERSION B**, but the served `id` is a **new** UUID, not B's original |
| 6 | Publish for `runtimeVersion: 2.0.0` | Device stays on its current version — a mismatched runtime never receives an update |
| 7 | **Signature negative test** | Rotate the signing key on the server, publish a new release, relaunch → the client **refuses** it and stays put. Proves signing is enforced, not merely present. |
| 8 | Stop the server, enable airplane mode, relaunch | App still launches from cache. OTA must never be required for startup |
| 9 | **Deployments → Roll back to embedded** | Device reverts to **VERSION A**, the bundle inside the binary |

Steps 7 and 9 are the ones most likely to be skipped and most likely to matter. Step 7 is the
only proof that a compromised network cannot ship arbitrary JavaScript into the app. After step 7
you must reinstall the APK (its embedded certificate no longer matches the rotated key), so run
it last or plan for a rebuild.

## Watching what happens

```bash
adb logcat -s ExpoUpdates:V ReactNativeJS:V
docker compose logs -f oat | grep -E 'update_served|no_update_available|signing_failure'
```

The dashboard's **Simulator** tab replays the same request server-side and reports whether the
signature verifies — much faster than a build cycle when something is wrong.

## When it fails

`docs/troubleshooting.md` is keyed by the exact strings the client prints. The three most likely:

- **"No expo-signature header specified"** — the application has no active signing key, or the
  release was imported before one existed. Republish.
- **"Key with keyid=… not found in client configuration"** — `codeSigningMetadata.keyid` does not
  match what the server signed with. Both must say `main`.
- **Nothing in the server logs at all** — the request never arrived. Debug build, wrong URL, or
  the device cannot resolve the domain.

## Recording the result

When the checklist passes, tick Phase 12 in `docs/roadmap.md` and paste a successful
`update_served` logcat trace and a `noUpdateAvailable` trace into `docs/troubleshooting.md` as
reference output. Then OAT is production-ready by the definition in `expo-oat.md` §61.

iOS follows the same checklist and must pass independently — a working Android path proves
nothing about the iOS client's certificate handling.
