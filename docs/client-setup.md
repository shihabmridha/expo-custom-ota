# Client setup and code signing

Configuring an Expo app to receive updates from expo-custom-ota. The dashboard's **Client
setup** tab generates all of this for your application — prefer copying from there, since it
fills in the real URL and keyid.

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

> **Two identifiers, and they are not interchangeable.**
> `ota_…` in the updates URL is the **update key** — public, embedded in the app, what devices
> send. The **application id** is a UUID, used by every `/api/admin` route and by the CLI's
> `--app` / `OTA_APP_ID`. The Client setup tab shows both.

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

**`codeSigningMetadata.keyid` must match exactly.** expo-custom-ota signs as `main` by default,
while the native client's own default is `root` — always set it explicitly. A mismatch makes the
client reject every update with "Key with keyid=… not found in client configuration"; it does
not fall back to unsigned.

**Updates are disabled in development builds.** You must test against a release build, and
`expo-updates` typically applies a downloaded update on the *next* launch, so relaunch twice.

## Code signing

Signing is what makes a self-hosted update server safe: without it, anyone who can answer the
update URL — a compromised host, a hostile network, a misconfigured proxy — can ship arbitrary
JavaScript into your app. Do not run production unsigned. (An application with no signing key
serves unsigned updates to clients not configured for signing, and returns a clear
`SIGNING_UNAVAILABLE` error to clients that request a signature.)

**What you have to do: nothing extra.** expo-custom-ota generates a dedicated RSA-2048 key per
application when you create it (or from the **Signing** tab). Download the certificate from the
Signing tab, save it as `certs/certificate.pem`, and **commit it** — it is public, and the
client verifies against the certificate it was built with, not one fetched at runtime. The
private key stays on the server under `SIGNING_KEYS_DIRECTORY` — never in the database, never
returned by the API. **Back that directory up**: the certificate is embedded in binaries
already in the app stores, so a lost key means those binaries can never receive another update.

### This is not your app signing key

Your Android keystore (or iOS distribution certificate) signs the *installable package*; the
OTA key signs the *update manifest*, verified by `expo-updates` at runtime. They are not
interchangeable, and reusing the app key would not even work:

- `expo-updates` requires a certificate with `keyUsage: digitalSignature` and
  `extKeyUsage: codeSigning` — a `keytool` certificate has neither and is rejected with
  "First certificate in chain is not a code signing certificate".
- Only RSA PKCS#1 v1.5 with SHA-256 is supported — an EC keystore key cannot be used at all.

expo-custom-ota rejects both cases when a certificate is saved rather than letting them fail on
device. Keeping the keys separate also contains the blast radius of a server compromise: the
attacker can serve JavaScript, but cannot sign installable packages.

### How it works, in one paragraph

The manifest contains the SHA-256 of every asset and the client verifies those hashes after
download, so one RSA signature (`rsa-v1_5-sha256` — the only algorithm `expo-updates` supports)
over the exact manifest bytes protects everything. The signature travels as a per-part
`expo-signature` header. Note the signature is standard base64 with padding while asset hashes
are base64url without padding — different encodings, on purpose.

### Rotation

Rotating (Signing tab) generates a new key and retires the old one, but **does not re-sign
existing releases** — signing happens at import time. After rotating you must republish, and,
because the certificate is embedded in the binary, ship new binaries before devices can accept
anything signed with the new key. Rotate rarely, and treat it as a native release, not a
JavaScript one.

## Verifying before you build

Use the **Simulator** tab. It replays exactly what your device will ask for, shows what it
would get, and reports whether the signature verifies — much faster than a build cycle.

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

## Attributing updates to your own users

The **Devices** tab shows which installs received each update. That works with no client changes:
every `expo-updates` client already sends an `EAS-Client-ID` header — despite the name it comes
from the client library, not from EAS — and the server keys installs on it. It is a random UUID
minted on first run and reset on reinstall, so it identifies an *install*, never a person.

To see your own user ids alongside them, send one. **Send an opaque id, not an email address** —
whatever you send is stored verbatim and shown in the dashboard (never written to server logs,
but in the database until pruned).

`requestHeaders` is baked in at build time, so a user id only known after login cannot go there.
Set it at runtime instead, as the `user-id` extra param:

```js
import * as Updates from 'expo-updates';

// Persisted by expo-updates and sent on every later update request.
await Updates.setExtraParamAsync('user-id', 'usr_12345');
```

If your build somehow does not send `EAS-Client-ID`, supply your own install id the same way, as
an extra param named `install-id`.

Extra-param keys must be **lowercase, with hyphens**: `expo-extra-params` is an RFC 8941
Structured Field dictionary, and a camelCase key such as `userId` does not merely look wrong —
the *entire* header fails to parse and every extra param beside it vanishes too. The server logs
`extra_params_unparsable` at debug level when that happens.

To store nothing at all, run the server with `DEVICE_TRACKING_ENABLED=false`.

## Recording the device for debugging

When one install misbehaves, "which phone and which OS" is usually the first question. The
server stores three optional extra params on the install row and shows them in the **Devices**
tab, next to the user id:

| Extra param    | Source (`expo-device`) | Example       |
| -------------- | ---------------------- | ------------- |
| `os-version`   | `Device.osVersion`     | `17.5.1`      |
| `device-brand` | `Device.brand`         | `Apple`       |
| `device-model` | `Device.modelName`     | `iPhone 15 Pro` |

Brand is always `Apple` on iOS, so send the model too — it is what tells iPhones apart.

```js
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';

await Updates.setExtraParamAsync('os-version', Device.osVersion ?? '');
await Updates.setExtraParamAsync('device-brand', Device.brand ?? '');
await Updates.setExtraParamAsync('device-model', Device.modelName ?? '');
```

Call this on every launch: the OS version changes when the user upgrades, and the last value
sent wins. A launch that omits a param keeps the previously stored value. Values are limited to
64 printable ASCII characters; anything else is dropped rather than truncated. These facts are
never used to decide which update a device is served.

## Failure behaviour

OTA must never be required for the app to start. If the server is offline, the network times
out, no deployment exists, or the manifest request fails, the app keeps running its embedded or
last cached bundle. Do not build startup logic that blocks on an update check.
