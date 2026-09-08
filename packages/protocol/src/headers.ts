/**
 * Header names used by the Expo Updates v1 protocol.
 *
 * Lowercase throughout: `Headers.get` is case-insensitive, but we also compare
 * these as plain strings when building multipart part headers.
 *
 * Several of these appear in no published spec yet are sent by every real
 * client — see `docs/protocol-notes.md`.
 */

// --- Request ---------------------------------------------------------------
export const H_PROTOCOL_VERSION = 'expo-protocol-version';
export const H_API_VERSION = 'expo-api-version';
export const H_PLATFORM = 'expo-platform';
export const H_RUNTIME_VERSION = 'expo-runtime-version';
export const H_UPDATES_ENVIRONMENT = 'expo-updates-environment';
export const H_JSON_ERROR = 'expo-json-error';
export const H_EAS_CLIENT_ID = 'eas-client-id';
export const H_FATAL_ERROR = 'expo-fatal-error';
export const H_EXPECT_SIGNATURE = 'expo-expect-signature';
export const H_ACCEPT = 'accept';

/** Undocumented but load-bearing: the directive logic depends on these. */
export const H_CURRENT_UPDATE_ID = 'expo-current-update-id';
export const H_EMBEDDED_UPDATE_ID = 'expo-embedded-update-id';
export const H_RECENT_FAILED_UPDATE_IDS = 'expo-recent-failed-update-ids';
export const H_EXTRA_PARAMS = 'expo-extra-params';

/**
 * Channel. Not a protocol header — it arrives via the generic
 * `updates.requestHeaders` config. `expo-channel-name` is what EAS and every
 * Expo tool use; `x-ota-channel` is accepted only as a legacy fallback (D6).
 */
export const H_CHANNEL_NAME = 'expo-channel-name';
export const H_CHANNEL_NAME_LEGACY = 'x-ota-channel';

/**
 * Application-supplied user identifier. Like the channel this is not a protocol
 * header — it travels through the generic `updates.requestHeaders` config, so
 * its value is baked into the binary at build time. An id only known after
 * login must instead be set at runtime with `Updates.setExtraParamAsync` under
 * the `P_USER_ID` key, which arrives in `expo-extra-params`. The header wins
 * when both are present.
 *
 * Whatever the app sends is stored verbatim and shown in the dashboard. Send an
 * opaque id, never an email address. See D16 in `docs/decisions.md`.
 */
export const H_USER_ID = 'x-ota-user-id';

// --- Extra params ----------------------------------------------------------
//
// Keys inside `expo-extra-params`, set at runtime with
// `Updates.setExtraParamAsync`. All lowercase because they have to be: the
// header is an RFC 8941 dictionary, whose keys are lowercase by grammar. A
// camelCase key does not merely look wrong — the whole dictionary fails to
// parse and every pair in it vanishes.

/** Runtime alternative to `H_USER_ID`. */
export const P_USER_ID = 'user-id';
/** Install id fallback when the client sends no `eas-client-id` (D16). */
export const P_INSTALL_ID = 'install-id';
/**
 * Device facts for debugging a misbehaving install: OS version, brand, model.
 * Sourced from `expo-device` on the client. Stored on `device_installs`, shown
 * in the dashboard, never read by update selection. See D18.
 */
export const P_OS_VERSION = 'os-version';
export const P_DEVICE_BRAND = 'device-brand';
export const P_DEVICE_MODEL = 'device-model';

/** RFC 3229 delta encoding. We never implement it — ignore and return a full 200. */
export const H_A_IM = 'a-im';

// --- Response --------------------------------------------------------------
export const H_SFV_VERSION = 'expo-sfv-version';
export const H_SIGNATURE = 'expo-signature';
export const H_MANIFEST_FILTERS = 'expo-manifest-filters';
export const H_SERVER_DEFINED_HEADERS = 'expo-server-defined-headers';
export const H_CONTENT_TYPE = 'content-type';
export const H_CONTENT_DISPOSITION = 'content-disposition';
export const H_CACHE_CONTROL = 'cache-control';

// --- Constant values -------------------------------------------------------
export const PROTOCOL_VERSION_1 = '1';
export const SFV_VERSION = '0';
/** Short cache: the client must not be handed a stale manifest. */
export const MANIFEST_CACHE_CONTROL = 'private, max-age=0';
/** Assets are content-addressed and therefore immutable forever. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const CT_JSON = 'application/json';
export const CT_EXPO_JSON = 'application/expo+json';
export const CT_MULTIPART_MIXED = 'multipart/mixed';
export const CT_JAVASCRIPT = 'application/javascript';

/** Read a header, trimming and normalising empty strings to null. */
export function readHeader(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
