# certs/

Put the application's code signing certificate here as `certificate.pem`.

Get it from the expo-custom-ota dashboard: **your application → Signing → certificate.pem**, or
**Client setup**, which shows it alongside the matching `app.json` snippet.

This is a **public** certificate and is meant to be committed. It gets embedded in the binary,
and the client verifies every update against it. The private key it pairs with never leaves the
server.

`.gitignore` ignores `*.pem` everywhere except this directory, precisely so this one is not
dropped by accident.

## Not your app signing key

This is **not** the keystore you build the APK with. They are different keys: the keystore signs
the package and is verified at install; this certificate signs update manifests and is verified at
runtime. A keytool certificate has no `extKeyUsage: codeSigning` and the client rejects it.

Keep using your existing keystore for the build.

## Order matters

The certificate must exist **before** you build the APK, because it is baked into the binary.
That means: deploy the server → create the application → copy the certificate here → *then*
build.

Rotating the signing key afterwards invalidates the embedded certificate, and the installed
binary can never accept another update without a rebuild.
