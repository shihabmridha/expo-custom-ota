# Code signing

Signing is what makes a self-hosted update server safe. Without it, anyone who can answer the
update URL — a compromised host, a hostile network, a misconfigured proxy — can ship arbitrary
JavaScript into your app.

## How it works

Signing the manifest transitively covers everything, because the manifest contains the SHA-256
of every asset and the client verifies those hashes after download. So one signature protects
the bundle and all assets.

- **Algorithm:** RSA PKCS#1 v1.5 with SHA-256 (`rsa-v1_5-sha256`). This is the only algorithm
  `expo-updates` supports — not RSA-PSS, not ECDSA.
- **Signed payload:** the exact UTF-8 bytes of the manifest part body. There is no
  canonicalization, so the bytes that are signed and the bytes that are sent must be identical.
- **Header:** `expo-signature: sig="<base64>", keyid="main"`, a per-part header in the multipart
  response.

Note the signature is **standard base64 with padding**, while asset hashes are **base64url
without padding**. Easy to confuse; they are different encodings on purpose.

## Keys

Each application gets its own RSA-2048 key, so a compromise is contained to one app rather than
the whole platform.

Generate one from the **Signing** tab, or automatically when creating an application.
Certificates are produced by `@expo/code-signing-certificates` — Expo's own library — so the
extensions match what the client validates:

- X.509 v3, self-signed, RSA-2048, SHA-256
- `keyUsage` critical: `digitalSignature`, not `keyCertSign`
- `extKeyUsage` critical: `codeSigning`

The `expoProjectInformation` extension is only for Expo Go / dev-client certificates and is not
needed here.

## Where the private key lives

On disk under `SIGNING_KEYS_DIRECTORY` — in production, a mounted secret. It is never stored in
the database, never returned by the API, and never sent to the dashboard. The API does not even
expose its filename.

Losing it is serious: the certificate is embedded in binaries already in the app stores, so a
lost key means those binaries can never receive another update. Back up the signing keys
directory.

## Client configuration

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

`keyid` must match exactly. The native client's own default is `root` while Expo's CLI writes
`main` — always set it explicitly. A mismatch makes the client reject every update with "Key
with keyid=… not found in client configuration"; it does not fall back to unsigned.

The certificate is public and belongs in your repository. It must be embedded in the binary,
because the client verifies against the certificate it was built with — not one fetched at
runtime.

## Rotation

Rotating generates a new key, retires the old one, and updates the certificate shown on the
Client setup tab.

**Rotation does not re-sign existing releases.** Signing happens at import time, so anything
already published carries the old signature and will be refused by clients configured for the
new certificate. After rotating you must republish, and — because the certificate is embedded in
the binary — ship new binaries before devices can accept anything signed with the new key.

In practice: rotate rarely, and treat it as a native release, not a JavaScript one.

## Verifying manually

```bash
# Extract the manifest part and its signature from a live response, then:
openssl x509 -pubkey -noout -in certificate.pem > pub.pem
openssl dgst -sha256 -verify pub.pem -signature sig.bin manifest.json
# Verified OK
```

The **Simulator** tab does this for you against the stored certificate and reports the result,
which is the fastest way to confirm a release is servable before touching a device.

## Unsigned applications

An application with no signing key serves unsigned updates. That works for a client that is not
configured for code signing, and OAT returns a clear `SIGNING_UNAVAILABLE` error rather than
silently serving unsigned bytes when a client asks for a signature.

Do not run production this way.
