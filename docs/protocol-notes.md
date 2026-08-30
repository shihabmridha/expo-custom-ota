# Expo Updates v1 — protocol ground truth

> **RESEARCHED — DO NOT RE-DERIVE.**
> Compiled from the published spec, the official `custom-expo-updates-server` reference
> implementation, and the actual `expo-updates` client source (Android `FileDownloader.kt`,
> iOS `FileDownloader.swift`, `CodeSigningConfiguration.kt`, `@expo/cli createMetadataJson.ts`).
> Where the spec and the real client disagree, the client wins — it is what runs on devices.

Sources:
- <https://docs.expo.dev/technical-specs/expo-updates-1/>
- <https://github.com/expo/custom-expo-updates-server>
- <https://github.com/expo/expo> — `packages/expo-updates/**`, `packages/@expo/cli/src/export/**`
- <https://github.com/expo/code-signing-certificates>

---

## Quick reference

| Fact | Value |
|---|---|
| Asset `hash` | base64url SHA-256 of raw bytes, **padding stripped**, 43 chars |
| Signature `sig` | **standard base64, with padding** — deliberately different from the above |
| Signed payload | the **exact UTF-8 bytes of the part body**; there is no canonicalization step |
| Algorithm | RSA PKCS#1 v1.5 + SHA-256 (`rsa-v1_5-sha256`). PSS and ECDSA are unsupported |
| `keyid` | must **exactly match** the client's `codeSigningMetadata.keyid` or the client throws |
| Multipart parts | `manifest`, `extensions`, `directive`, `certificate_chain` |
| `expo-signature` | a **per-part** header in multipart; top-level only in the bare-JSON response form |
| `extra.expoClient` | the correct key (the reference repo's own JSDoc saying `expoConfig` is wrong) |
| Directives | protocol v1 + multipart only; **must also be signed** when `expo-expect-signature` was sent |
| No deployment | `200` + `noUpdateAvailable` directive — **not** `404` |
| Channel | not a protocol header; arrives as `expo-channel-name` via `updates.requestHeaders` |
| `A-IM: bsdiff` | ignore it, return a normal `200` full body — never `226 IM Used` |
| Bundle filename | `.hbc` vs `.js` is unstable across SDKs — always read `fileMetadata[platform].bundle` |
| `assets: []` | legal (SDK 52+ omits binary-embedded assets) — must be tolerated |

---

## Request

Method is `GET`. Non-GET → `405`.

What a **real client** sends (not what the spec example shows):

```
Accept: multipart/mixed,application/expo+json,application/json
Expo-Platform: ios | android
Expo-Protocol-Version: 1
Expo-API-Version: 1
Expo-Updates-Environment: BARE
Expo-JSON-Error: true
EAS-Client-ID: <uuid>
Expo-Runtime-Version: <string>
Expo-Fatal-Error: <string>            (conditional, truncated to 1024 chars)
expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"   (conditional)
<plus every key/value from updates.requestHeaders>
```

Note `multipart/mixed` is **first** and there are **no q-params** — the spec's example shows
the opposite. Prefer multipart whenever it appears; directives require it.

### Undocumented but load-bearing

These appear in no published spec, yet every real client sends them and the directive logic
depends on them:

| Header | Meaning |
|---|---|
| `expo-current-update-id` | lowercased UUID of the currently launched update |
| `expo-embedded-update-id` | lowercased UUID of the update embedded in the binary |
| `expo-recent-failed-update-ids` | SFV List of update ids that failed to launch |
| `expo-extra-params` | SFV Dictionary, string-valued |

Server-defined headers returned in a previous response's `expo-server-defined-headers` are
merged into subsequent requests **first**, so anything sent there is replayed.

### Protocol version 0 vs 1

Absent `expo-protocol-version` ⇒ version **0**. The published docs never state the delta;
derived from the reference server:

| Feature | v0 | v1 |
|---|---|---|
| Manifest body + assets | yes | yes |
| `directive` part | no | yes |
| `noUpdateAvailable` | no | yes |
| `rollBackToEmbedded` | no | yes |
| `expo-current-update-id` short-circuit | no | yes |

Current clients always send `1`.

### Channel

The channel is **not** a first-class protocol header. It arrives through the generic
`updates.requestHeaders` config:

```json
{
  "expo": {
    "updates": {
      "url": "https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2",
      "requestHeaders": { "expo-channel-name": "production" }
    }
  }
}
```

The V1 spec doc (`expo-oat.md` §11, §40 — removed from the repo; `git show 6954f00^:expo-oat.md`) shows `x-ota-channel`. That is
**wrong** — EAS and every existing tool use `expo-channel-name`. We read `expo-channel-name`
first and accept `x-ota-channel` as a legacy fallback. See `docs/decisions.md` D6.

---

## Response

Headers:

```
expo-protocol-version: 1
expo-sfv-version: 0
cache-control: private, max-age=0
content-type: multipart/mixed; boundary=<boundary>
```

`expo-manifest-filters` and `expo-server-defined-headers` are optional SFV dictionaries; the
reference server omits both and so do we.

### Multipart layout (exact bytes)

```
--{boundary}\r\n
content-disposition: form-data; name="manifest"\r\n
content-type: application/json\r\n
expo-signature: sig="<base64>", keyid="main"\r\n
\r\n
{manifest body}\r\n
--{boundary}\r\n
content-disposition: form-data; name="extensions"\r\n
content-type: application/json\r\n
\r\n
{"assetRequestHeaders":{}}\r\n
--{boundary}--\r\n
```

No preamble. CRLF throughout. Part order is not strict. A zero-part response may be `204`.

Web `FormData` cannot express this — it emits `multipart/form-data` with an opaque boundary
and no per-part custom headers — so the writer is hand-rolled.

### Manifest

```ts
type Manifest = {
  id: string;              // MUST be UUID-formatted; client calls UUID.fromString
  createdAt: string;       // ISO 8601
  runtimeVersion: string;
  launchAsset: Asset;
  assets: Asset[];
  metadata: Record<string, string>;
  extra: Record<string, any>;   // { expoClient: <public expo config> }
};

type Asset = {
  hash?: string;           // base64url SHA-256, unpadded
  key: string;             // hex MD5 in the reference server; any stable unique string is legal
  contentType: string;     // launchAsset: "application/javascript"
  fileExtension?: string;  // "." + ext; launchAsset gets ".bundle"
  url: string;             // absolute
};
```

`extensions` part body: `{ assetRequestHeaders: { [assetKey]: { [header]: string } } }`.

### Directives

Protocol v1 + multipart only. Must be signed if `expo-expect-signature` was sent.

```json
{ "type": "noUpdateAvailable" }
{ "type": "rollBackToEmbedded", "parameters": { "commitTime": "2026-03-13T12:34:56.789Z" } }
```

- `noUpdateAvailable` — when `expo-current-update-id` equals the deployed update id, or when
  no deployment exists at all.
- `rollBackToEmbedded` — requires `expo-embedded-update-id` to be present. If current ==
  embedded, send `noUpdateAvailable` instead. `commitTime` is required: the client treats the
  rollback as a pseudo-update with that timestamp to compare recency.

---

## Code signing

- Algorithm: **RSA PKCS#1 v1.5 + SHA-256**. Node `RSA-SHA256` = JCA `SHA256withRSA` =
  WebCrypto `RSASSA-PKCS1-v1_5`/`SHA-256` = protocol `rsa-v1_5-sha256`. **PSS and ECDSA are
  not supported by the client.** RSA-2048.
- The signed payload is the **exact UTF-8 bytes of the part body**. Serialize once, then sign
  *and emit that identical string*. Any re-serialization (key reorder, whitespace, a proxy
  re-encoding) breaks verification.
- Header: `expo-signature: sig="<standard base64, padded>", keyid="main"`. `alg` is optional
  and a mismatch only logs client-side, so we omit it.
- With `includeManifestResponseCertificateChain: false` — the self-hosted case — the client's
  embedded `codeSigningCertificate` **is** the verification key, and `keyid` must match
  `codeSigningMetadata.keyid` exactly or the client throws. We never emit a
  `certificate_chain` part.
- Certificate: X.509 v3, self-signed, RSA-2048, SHA-256, `keyUsage` critical with
  `digitalSignature: true` / `keyCertSign: false`, `extKeyUsage` critical with
  `codeSigning: true`. The `expoProjectInformation` extension is for Expo Go / dev-client
  certificates only and is **not** needed self-hosted.

Client config:

```json
{
  "expo": {
    "updates": {
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

The native client's default `keyid` is `"root"` while the Expo CLI writes `"main"` — always
set it explicitly on both sides.

---

## `expo export` layout

```
dist/
├── metadata.json
├── _expo/static/js/{ios,android}/entry-<hash>.hbc     # or .js — read it, don't derive it
└── assets/<md5-hash>                                  # NO file extension
```

```json
{
  "version": 0,
  "bundler": "metro",
  "fileMetadata": {
    "ios":     { "bundle": "_expo/static/js/ios/entry-<hash>.hbc",
                 "assets": [{ "path": "assets/<hash>", "ext": "png" }] },
    "android": { "bundle": "...", "assets": [] }
  }
}
```

- `version` is always `0`, `bundler` always `"metro"`.
- `web` is excluded from `fileMetadata`.
- `assets[].path` is always `assets/<hash>`; `ext` has **no leading dot**.
- `assets` can be empty — SDK 52+ omits assets already embedded in the native binary.
- Under React Server Components `bundle` is prefixed with `client/`.

### Verified against a real SDK 57 export (2026-08-10, Windows)

Two things the documentation gets wrong, both confirmed by generating an actual export:

1. **The bundle filename is `index-<hash>.hbc`, not `entry-<hash>.hbc`.** Widely-cited examples
   use `entry-`. Always read `fileMetadata[platform].bundle`; never construct it.

2. **Asset paths use backslashes when the export is produced on Windows.**
   `@expo/cli`'s `createMetadataJson` builds them with `path.join`, so a real Windows export
   contains:

   ```json
   { "path": "assets\\cb975bba2216ce10a60e6c0ffe9941a2", "ext": "png" }
   ```

   ZIP entry names are always forward-slashed, so an importer matching these literally finds
   nothing — and reports "asset missing from archive" for every asset. `normalizeExportPath`
   in `packages/protocol/src/export-metadata.ts` handles this; the fixture pins the behaviour.

### `expoConfig.json` is NOT produced by `expo export`

It must be generated separately from `@expo/config`:

```js
const { exp } = require('@expo/config').getConfig(projectDir, {
  skipSDKVersionRequirement: true,
  isPublicConfig: true,
});
```

`isPublicConfig: true` strips private fields. The result becomes `manifest.extra.expoClient`,
which is what populates `Constants.expoConfig` on device. We **require** it in the upload
archive; the `expo-custom-ota` CLI's `pack` command generates it (`packages/cli/src/pack.ts`).

### Runtime version

Does not appear in `metadata.json`. It lives in the app config (`runtimeVersion` string or
`{ policy }`) and is baked into `Expo.plist` / `AndroidManifest.xml` at build time.

> **The reference server echoes the client's `expo-runtime-version` header straight into the
> manifest.** That is a correctness bug — it means the server asserts whatever the client
> claims. We store the runtime version per release variant at import time and emit the stored
> value.

---

## Status codes

| Situation | Response |
|---|---|
| non-GET | 405 |
| invalid `expo-protocol-version` | 400 |
| platform not `ios`/`android` | 400 |
| missing runtime version | 400 |
| unsupported `Accept` | 406 |
| unknown update key | 404 |
| no deployment | **200 + `noUpdateAvailable` directive** |
| update available | 200 multipart |

---

## Known spec-vs-implementation conflicts

1. `certificate_chain` part is parsed by the client but undocumented in the spec.
2. `expo-current-update-id` / `expo-embedded-update-id` / `expo-recent-failed-update-ids` /
   `expo-extra-params` / `expo-api-version` / `expo-updates-environment` / `expo-json-error` /
   `eas-client-id` / `expo-fatal-error` are all undocumented but universally sent.
3. `expo-signature` placement: top-level in the spec's header list, per-part in multipart.
4. Accept-header ordering differs between the spec example and the real client.
5. `extra.expoConfig` (reference JSDoc) vs `extra.expoClient` (reference code). The code is right.
6. `fileExtension` on `launchAsset`: spec says omit, reference sends `.bundle`. Client ignores it.
7. Default `keyid`: `"root"` in the native client, `"main"` from the CLI and reference server.
8. `sig` is padded standard base64; asset `hash` is unpadded base64url. Easy to get backwards.
9. Bundle extension `.hbc` vs `.js` is not stable across SDK versions.
10. The reference server uses `fs.stat().birthtime` for `createdAt` and rollback `commitTime`;
    unreliable outside macOS. Use a real database column.
