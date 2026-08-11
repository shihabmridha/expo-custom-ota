# Phase 12 results

Evidence from actual runs — screen output and server log lines, not assertions.

---

## Pass 1 — LAN, Android emulator · **ALL 9 STEPS PASS**

| | |
|---|---|
| Server | `http://192.168.0.53:3000` (laptop, plain HTTP over LAN) |
| Client | Android emulator on a second machine, same network |
| Application | `oat-e2e` · `xyz.acadion.oate2e` · runtime `1.0.0` |
| Build | `expo run:android --variant release`, Expo SDK 57 |
| Date | 2026-08-10 |

Every step is corroborated by a server log line, not just the screen — the two can disagree, and
which one is lying is the whole diagnostic question.

### 1. Install the release APK — PASS

VERSION A, launched from the bundle embedded in the binary.

```
updateId: 00a0a796-0650-4a08-8296-d7e8360e5f03   isEmbeddedLaunch: true
```

```json
{"event":"no_update_available","currentUpdateId":"00a0a796-…","reason":"no_deployment"}
```

`currentUpdateId` matches the on-screen id, so the client reports its embedded update id — which
step 9 depends on. Confirms in one step: cleartext exemption applied · LAN routing · channel
header delivered via `requestHeaders` · runtime matched.

### 2. Publish B — PASS

```json
{"event":"update_served","currentUpdateId":"00a0a796-…","servedUpdateId":"ca1c5af7-…"}
```

Verified before the device asked: the served manifest's signature validated against the exact
certificate file embedded in the APK, and the launch bundle was retrievable over the LAN
(1,450,705 bytes). Both the automatic `ON_LOAD` check and the explicit API path reached the
server.

### 3. Relaunch → `noUpdateAvailable` — PASS

```json
{"event":"no_update_available","currentUpdateId":"ca1c5af7-…","reason":"already_current"}
```

The device now reports the update it is running, and the server declines to re-serve it. This is
what stops a redownload loop on every launch.

### 4. Publish C — PASS

```json
{"event":"update_served","currentUpdateId":"ca1c5af7-…","servedUpdateId":"6770b9ab-…"}
```

### 5. Roll back to the B release — PASS

New release #3 over B's contents:

```json
{"event":"update_served","currentUpdateId":"6770b9ab-…","servedUpdateId":"948fb858-…"}
```

Screen showed B again, but the update id was `948fb858-…`, **not** B's original `ca1c5af7-…` —
clients are never pointed backwards. Storage went from 12 asset references to 18 across still
**6 objects on disk**: the rollback re-uploaded nothing.

### 6. Publish for runtime 2.0.0 — PASS

```
runtime 1.0.0 device → {"type":"noUpdateAvailable"}
runtime 2.0.0 device → 3ef43950-…
```

The 2.0.0 release was deliberately labelled *"D — SHOULD NEVER APPEAR ON RUNTIME 1.0.0"*. The
device stayed on B. Four deployments coexist: `production` × {android, ios} × {1.0.0, 2.0.0}.

### 7. Signature negative test — PASS

Signing key rotated server-side, keyid left as `main` so the client could not reject on a name
mismatch and had to verify the signature itself.

```
verifies against the certificate inside the installed APK: false
verifies against the certificate the server now holds:     true
```

```json
{"event":"update_served","servedUpdateId":"7ac6d51e-…"}   ×3, no server-side errors
```

The server delivered the manifest successfully; the device **refused it** and stayed on the
embedded VERSION A. Because the request succeeded, only signature verification can have rejected
it. This is the step proving signing is enforced rather than merely present — without it, anyone
able to answer the update URL could ship arbitrary JavaScript.

The client surfaces this as a generic `failed to check for update`; the specific cause appears
only in `adb logcat -s ExpoUpdates:V`.

### 8. Offline tolerance — PASS

Server stopped. The app launched normally from its cached bundle and showed VERSION B.
`checkForUpdateAsync` rejected with a caught error rather than crashing. OTA is not a
prerequisite for startup.

### 9. Roll back to embedded — PASS

```json
{"event":"roll_back_to_embedded_served","currentUpdateId":"948fb858-…"}
```

Device reverted to VERSION A, the bundle inside the binary. All three cases behaved:

```
reports embedded id    → rollBackToEmbedded (with commitTime)
reports no embedded id → noUpdateAvailable  (degrades rather than sending an unusable directive)
already on embedded    → noUpdateAvailable  (no loop)
```

---

## Bugs this pass found

None were visible from tests alone; each needed the real client or a real rotation.

| | |
|---|---|
| **Signing key rotation was impossible** | `UNIQUE(application_id, key_id)` blocked a second key with keyid `main` even after retiring the first — but the keyid must stay `main` to match shipped binaries. Failed with an opaque constraint error. Fixed: migration `0001`, plus three regression tests. |
| **`drizzle.config.ts` produced a doubled path** | An absolute POSIX `out` was joined onto cwd, giving `D:\repo\D:\repo\…` and ENOENT on the snapshot. Every migration after the first would have failed. Now relative-to-cwd with POSIX separators, which satisfies both the globber and the joiner. |
| **The test app ignored the kill-switch** | A rollback returns `isAvailable: false` with `isRollBackToEmbedded: true`; branching only on `isAvailable` silently ignores it. Real trap for any custom update UI — documented in `troubleshooting.md`. |
| **`asset_served` was never emitted** | A declared log event with no call site, so "did the bundle actually download" was unanswerable server-side. Now logged at debug level. |

---

## Pass 2 — VPS (`https://ota.acadion.xyz`)

_Not started._ Requires a deploy, then `bun run e2e:setup` against it and a rebuild — the
certificate differs, so this is a genuine rebuild rather than a config change. No cleartext
exemption there.

## iOS

_Not started._ Must pass independently: a working Android path proves nothing about the iOS
client's certificate handling.

## Pass 1 addendum — install identity

_Not started._ Phase 14 (per-install tracking) keys every install row on the `EAS-Client-ID`
header. [protocol-notes.md](protocol-notes.md) records it as universally sent by real clients,
sourced from `FileDownloader.kt` / `FileDownloader.swift`, but **this repo has never observed
it**: Pass 1 logged only `currentUpdateId` and `servedUpdateId`, and the `clientHeaders()` test
helper did not send it until Phase 14 added it.

`backend/src/routes/updates.ts` now logs `easClientId` on every `update_served` /
`no_update_available` / `roll_back_to_embedded_served` line, at info level, so confirming it costs
one existing procedure:

1. Rebuild the release APK per [device-verification.md](device-verification.md).
2. Repeat step 1 of Pass 1.
3. `grep easClientId` the server log.

Record the result here either way — a negative is as useful as a positive, because it decides
whether `install-id` (via `Updates.setExtraParamAsync`) is the fallback or the primary path.
