# e2e

`expo-test-app` is a minimal Expo application for Phase 12 — verifying that signed OTA updates
actually reach a physical device.

It is **not** part of the Bun workspace and is not built by `bun install` at the root. It has its
own dependencies and is only touched when running device verification.

Full procedure: [`docs/device-verification.md`](../docs/device-verification.md).

## The short version

```bash
# once, after the server is deployed and the application created
cd e2e/expo-test-app
# → set updates.url in app.json to your application's OTA URL
# → save the certificate to certs/certificate.pem
bun install
bunx expo run:android --variant release     # release build; updates are inert in debug

# for each new version
# → edit VERSION in App.tsx
bun run pack                                 # export + expoConfig.json + zip
# → upload update.zip from the dashboard, publish, relaunch the app twice
```

`App.tsx` renders the version letter plus the update id, channel, runtime version and whether
the launch came from the embedded bundle — enough to diagnose a failure from the screen alone,
without attaching a debugger.
