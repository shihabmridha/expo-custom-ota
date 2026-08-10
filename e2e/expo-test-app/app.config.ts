import type { ExpoConfig } from 'expo/config';

/**
 * Config for the OAT verification app.
 *
 * Driven by environment variables so the same checkout can point at a LAN
 * server or the production VPS without editing files — which matters because
 * `updates.url` must match the server's `OTA_PUBLIC_URL` exactly, and a
 * mismatch is baked into the binary.
 *
 *   OAT_UPDATE_URL   full update URL, including the update key
 *   OAT_CHANNEL      channel to request (default: production)
 *   OAT_KEY_ID       code signing keyid (default: main)
 *   OAT_RUNTIME      runtime version (default: 1.0.0)
 *
 * Example — LAN test against a laptop:
 *   OAT_UPDATE_URL=http://192.168.0.53:3000/api/v1/updates/ota_XXXX bunx expo run:android --variant release
 *
 * Example — production:
 *   OAT_UPDATE_URL=https://ota.acadion.xyz/api/v1/updates/ota_XXXX bunx expo run:android --variant release
 */
const updateUrl =
  process.env.OAT_UPDATE_URL ?? 'https://ota.acadion.xyz/api/v1/updates/REPLACE_WITH_UPDATE_KEY';

const channel = process.env.OAT_CHANNEL ?? 'production';
const keyId = process.env.OAT_KEY_ID ?? 'main';
const runtimeVersion = process.env.OAT_RUNTIME ?? '1.0.0';

/**
 * Android 9+ blocks cleartext HTTP by default, so a plain-HTTP LAN server is
 * unreachable without an exemption — and the failure is silent: no request ever
 * leaves the device, so the server logs stay empty.
 *
 * Derived from the URL rather than set by hand, so the exemption cannot be left
 * switched on for an HTTPS production build.
 */
const usesCleartextTraffic = updateUrl.startsWith('http://');

if (updateUrl.includes('REPLACE_WITH_UPDATE_KEY')) {
  console.warn(
    '\n⚠  OAT_UPDATE_URL is not set — using a placeholder. The build will not be able to fetch ' +
      'updates. Set it to your application’s OTA URL from the Client setup tab.\n',
  );
}
if (usesCleartextTraffic) {
  console.warn(
    `\n⚠  ${updateUrl} is plain HTTP, so this build enables cleartext traffic on Android. ` +
      'Fine for LAN testing; do not ship it.\n',
  );
}

const config: ExpoConfig = {
  name: 'OAT E2E',
  slug: 'oat-e2e',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'xyz.acadion.oate2e',
  },
  android: {
    package: 'xyz.acadion.oate2e',
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },

  // Must be an explicit string: OAT rejects uploads using a policy, because a
  // server cannot resolve one.
  runtimeVersion,

  updates: {
    url: updateUrl,
    // The channel is not a protocol header — it travels through the generic
    // requestHeaders mechanism.
    requestHeaders: { 'expo-channel-name': channel },
    codeSigningCertificate: './certs/certificate.pem',
    codeSigningMetadata: { keyid: keyId, alg: 'rsa-v1_5-sha256' },
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
  },

  plugins: usesCleartextTraffic
    ? [['expo-build-properties', { android: { usesCleartextTraffic: true } }]]
    : [],
};

export default config;
