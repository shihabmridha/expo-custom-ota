# Client setup

Configuring an Expo app to receive updates from expo-custom-ota. The dashboard's **Client setup** tab
generates all of this for your application — prefer copying from there, since it fills in the
real URL and keyid.

## app.json

```json
{
  "expo": {
    "runtimeVersion": "1.0.0",
    "updates": {
      "url": "https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2",
      "requestHeaders": {
        "expo-channel-name": "production"
      },
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": {
        "keyid": "main",
        "alg": "rsa-v1_5-sha256"
      }
    }
  }
}
```

Install `expo-updates` if you have not: `bunx expo install expo-updates`.

## The four things that trip people up

**`runtimeVersion` must be an explicit string.** A policy (`appVersion`, `nativeVersion`,
`fingerprint`) is resolved at native build time from the project's state — a server cannot
compute one. expo-custom-ota rejects uploads that use a policy, with a message saying so.

The runtime version is an **opaque string** matched exactly. `1.0.0` and `1.0` are different
runtimes. It exists to stop JavaScript that needs new native code from reaching a binary that
does not have it, so change it whenever you change native dependencies.

**The channel is not a protocol header.** It travels through the generic `requestHeaders`
mechanism as `expo-channel-name`. Anything you put in `requestHeaders` is sent on every update
request. If the header is absent, expo-custom-ota falls back to the application's default channel.

**`codeSigningMetadata.keyid` must match exactly.** expo-custom-ota signs as `main` by default. A mismatch
makes the client reject every update with "Key with keyid=… not found in client configuration" —
it does not fall back to unsigned.

**Updates are disabled in development builds.** You must test against a release build, and
`expo-updates` typically applies a downloaded update on the *next* launch, so relaunch twice.

## Code signing certificate

Download it from the **Signing** tab and save it as `certs/certificate.pem`. Commit it — it is a
public certificate, and it must be embedded in the binary for verification to work. The private
key never leaves the server.

If you prefer Expo's CLI to manage it:

```bash
bunx expo-updates codesigning:configure \
  --certificate-input-directory certs \
  --key-input-directory ../keys
```

but note that expo-custom-ota holds the private key, so generate the pair in expo-custom-ota and only bring the
certificate over.

## Verifying before you build

Use the **Simulator** tab. It replays exactly what your device will ask for and shows what it
would get, including whether the signature verifies. That is much faster than a build cycle.

From the command line:

```bash
curl -sS -D - \
  -H "Accept: multipart/mixed,application/expo+json,application/json" \
  -H "Expo-Platform: android" \
  -H "Expo-Protocol-Version: 1" \
  -H "Expo-Runtime-Version: 1.0.0" \
  -H "expo-channel-name: production" \
  -H 'expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"' \
  https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2
```

You should get `200`, `content-type: multipart/mixed`, and a `manifest` part carrying an
`expo-signature` header.

## Runtime overrides

`expo-updates` can override the channel at runtime, which is useful for a QA build that switches
channels without a rebuild:

```js
import * as Updates from 'expo-updates';

Updates.setUpdateRequestHeadersOverride({ 'expo-channel-name': 'staging' });
await Updates.fetchUpdateAsync();
await Updates.reloadAsync();
```

Any header you want to override at runtime must already be declared in
`updates.requestHeaders`.

## Failure behaviour

OTA must never be required for the app to start. If expo-custom-ota is offline, the network times out, no
deployment exists, or the manifest request fails, the app keeps running its embedded or last
cached bundle. Do not build startup logic that blocks on an update check.
