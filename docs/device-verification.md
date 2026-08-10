# Phase 12 — real-device verification

The last gate. Until this passes on a physical device, expo-custom-ota is pre-production.

Everything below is prepared except the two steps only you can do: deploying to the VPS and
building the APK.

---

## Two passes

Doing this against a LAN server first is much cheaper: every server-side fix is a restart rather
than a redeploy, and you will find the config mistakes there. Then repeat against the VPS, which
is the pass that counts.

An **emulator is a valid target** — it runs the same `expo-updates` client, so it exercises the
protocol, signing and rollback paths identically. A physical device additionally covers real
network conditions and is worth doing eventually, but nothing in this checklist requires one.

### Pass 1 — LAN

Server on one machine, Android SDK and emulator on another, same network.

```
  laptop 192.168.0.53                emulator machine
  ├── expo-custom-ota API      :3000  ◀──────────  emulator (LAN, plain HTTP)
  └── dashboard    :5173  ◀──────────  browser (upload releases)
```

Three things are already handled for this:

- `Bun.serve` binds `0.0.0.0`, and the Vite dev server sets `host: true`, so both are reachable
  from the LAN.
- Android 9+ blocks cleartext HTTP by default, and the failure is silent — no request leaves the
  device, so the server logs stay empty. `app.config.ts` enables the exemption automatically
  **when and only when** `OTA_UPDATE_URL` starts with `http://`, so it cannot leak into an HTTPS
  build.
- The dashboard runs on `:5173` while the API answers on `:3000`, so a LAN upload's `Origin`
  matches neither. In development the origin check accepts any port on the same host; production
  stays exact-match.

Set the server up:

```bash
# .env
OTA_PUBLIC_URL=http://192.168.0.53:3000    # the LAN IP, not localhost

bun run e2e:setup     # creates the application, writes certs/certificate.pem, prints the URL
bun run dev           # API :3000 + dashboard :5173, both on the LAN
```

`e2e:setup` is idempotent and reuses an existing signing key, because regenerating one would
invalidate the certificate already embedded in an installed build.

If the emulator cannot reach the server, check in this order: NordVPN or another VPN capturing
the route, Windows Firewall (`bun.exe` inbound must be allowed — it already is here), and that
you used the LAN IP rather than `localhost`. Note `10.0.2.2` is the emulator's alias for *its own
host's* loopback; for a server on a different machine, use that machine's LAN IP directly.

### Pass 2 — VPS

Re-run `bun run e2e:setup` with `OTA_PUBLIC_URL=https://ota.acadion.xyz`, rebuild the app with
the new URL, and work the checklist again. No cleartext exemption, and the certificate differs
because it is a different server — so this is a genuine rebuild, not a config tweak.

## The ordering that matters

**The code signing certificate is embedded in the binary.** So the certificate must exist
*before* you build, which means the server and the application must exist before you build too.
Getting this order wrong means rebuilding.

```
1. Deploy expo-custom-ota to ota.acadion.xyz
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

- **Name:** expo-custom-ota E2E
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
updates still come from expo-custom-ota.

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
reference output. Then expo-custom-ota is production-ready by the definition in `expo-oat.md` §61.

iOS follows the same checklist and must pass independently — a working Android path proves
nothing about the iOS client's certificate handling.
