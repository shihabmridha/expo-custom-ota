import { isPlatform, type Platform } from '@ota/types';
import { err, ok, type ProtocolResult } from './errors.ts';
import {
  H_ACCEPT,
  H_API_VERSION,
  H_CHANNEL_NAME,
  H_CHANNEL_NAME_LEGACY,
  H_CURRENT_UPDATE_ID,
  H_EAS_CLIENT_ID,
  H_EMBEDDED_UPDATE_ID,
  H_EXPECT_SIGNATURE,
  H_EXTRA_PARAMS,
  H_FATAL_ERROR,
  H_JSON_ERROR,
  H_PLATFORM,
  H_PROTOCOL_VERSION,
  H_RECENT_FAILED_UPDATE_IDS,
  H_RUNTIME_VERSION,
  H_USER_ID,
  readHeader,
} from './headers.ts';
import { parseSfvDictionary, parseSfvStringDictionary, parseSfvStringList } from './sfv.ts';

export interface ExpectSignature {
  /** Which certificate the client will verify with. Must match what we sign as. */
  keyid: string;
  /** Optional; a mismatch only logs client-side. */
  alg: string | null;
}

export interface ExpoUpdateRequest {
  /** Absent header means version 0 — directives are unavailable there. */
  protocolVersion: 0 | 1;
  apiVersion: number | null;
  platform: Platform;
  runtimeVersion: string;
  /** From `expo-channel-name`, or the legacy `x-ota-channel`. Null falls back to the app default. */
  channelName: string | null;
  /**
   * Per-install UUID minted by the client library. Sanitised, so a garbage
   * value is null rather than something that would key a row.
   */
  easClientId: string | null;
  /** App-supplied, opaque, absent unless the app sets `x-ota-user-id`. */
  userId: string | null;
  /** Normalised to lowercase — the client sends lowercased UUIDs. */
  currentUpdateId: string | null;
  embeddedUpdateId: string | null;
  recentFailedUpdateIds: string[];
  extraParams: Record<string, string>;
  expectSignature: ExpectSignature | null;
  /** True when the client accepts `multipart/mixed`, which directives require. */
  acceptsMultipart: boolean;
  jsonError: boolean;
  fatalError: string | null;
}

/** Default keyid in the native client when `codeSigningMetadata.keyid` is unset. */
const DEFAULT_KEY_ID = 'root';

/** A UUID is 36 characters; this is generous headroom, not a target. */
const MAX_IDENTIFIER_LENGTH = 128;
/** Printable ASCII without spaces — everything a sane id uses, nothing that needs escaping. */
const IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Bound an identifier arriving in a header.
 *
 * Rejects rather than truncates: cutting two distinct 200-character ids down to
 * 128 could silently merge two installs (or two users) into a single row, which
 * is worse than dropping both. `readHeader` has already trimmed and mapped the
 * empty string to null.
 */
export function sanitizeIdentifier(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length > MAX_IDENTIFIER_LENGTH) return null;
  return IDENTIFIER_PATTERN.test(raw) ? raw : null;
}

function parseAccept(raw: string | null): { multipart: boolean; json: boolean } {
  // No Accept header is treated as "anything", matching RFC 7231.
  if (raw === null) return { multipart: true, json: true };

  const types = raw
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter((t) => t.length > 0);

  const wildcard = types.includes('*/*');
  return {
    multipart: wildcard || types.includes('multipart/mixed') || types.includes('multipart/*'),
    json:
      wildcard ||
      types.includes('application/json') ||
      types.includes('application/expo+json') ||
      types.includes('application/*'),
  };
}

function parseExpectSignature(raw: string | null): ExpectSignature | null {
  if (raw === null) return null;

  const dict = parseSfvDictionary(raw);
  // A malformed header is treated as "no signature requested" rather than an
  // error: refusing to serve would brick the client, and an unsigned response
  // is rejected client-side anyway if it genuinely wanted one.
  if (!dict) return null;
  if (dict.get('sig') !== true) return null;

  const keyid = dict.get('keyid');
  const alg = dict.get('alg');
  return {
    keyid: typeof keyid === 'string' ? keyid : DEFAULT_KEY_ID,
    alg: typeof alg === 'string' ? alg : null,
  };
}

/**
 * Parse an incoming Expo update request into a validated shape.
 *
 * Deliberately takes `method` + `Headers` rather than a `Request` so this
 * package stays free of any HTTP framework and is trivial to unit test.
 */
export function parseExpoUpdateRequest(
  method: string,
  headers: Headers,
): ProtocolResult<ExpoUpdateRequest> {
  if (method.toUpperCase() !== 'GET') {
    return err('METHOD_NOT_ALLOWED', 405, `Method ${method} not allowed; use GET.`);
  }

  const rawProtocol = readHeader(headers, H_PROTOCOL_VERSION);
  let protocolVersion: 0 | 1;
  if (rawProtocol === null) {
    protocolVersion = 0;
  } else if (rawProtocol === '1') {
    protocolVersion = 1;
  } else if (rawProtocol === '0') {
    protocolVersion = 0;
  } else {
    return err(
      'INVALID_PROTOCOL_VERSION',
      400,
      `Unsupported ${H_PROTOCOL_VERSION}: ${rawProtocol}. This server implements version 1.`,
    );
  }

  const rawPlatform = readHeader(headers, H_PLATFORM)?.toLowerCase() ?? null;
  if (!isPlatform(rawPlatform)) {
    return err(
      'INVALID_PLATFORM',
      400,
      `Missing or invalid ${H_PLATFORM}: ${rawPlatform ?? '(absent)'}. Expected "ios" or "android".`,
    );
  }

  const runtimeVersion = readHeader(headers, H_RUNTIME_VERSION);
  if (runtimeVersion === null) {
    return err('MISSING_RUNTIME_VERSION', 400, `Missing ${H_RUNTIME_VERSION}.`);
  }

  const accept = parseAccept(readHeader(headers, H_ACCEPT));
  if (!accept.multipart && !accept.json) {
    return err(
      'NOT_ACCEPTABLE',
      406,
      'No supported response structure requested; this server returns multipart/mixed or application/json.',
    );
  }

  const rawApiVersion = readHeader(headers, H_API_VERSION);
  const parsedApiVersion = rawApiVersion === null ? Number.NaN : Number.parseInt(rawApiVersion, 10);

  const rawExtraParams = readHeader(headers, H_EXTRA_PARAMS);
  const rawFailedIds = readHeader(headers, H_RECENT_FAILED_UPDATE_IDS);

  return ok({
    protocolVersion,
    apiVersion: Number.isNaN(parsedApiVersion) ? null : parsedApiVersion,
    platform: rawPlatform,
    runtimeVersion,
    channelName: readHeader(headers, H_CHANNEL_NAME) ?? readHeader(headers, H_CHANNEL_NAME_LEGACY),
    easClientId: sanitizeIdentifier(readHeader(headers, H_EAS_CLIENT_ID)),
    userId: sanitizeIdentifier(readHeader(headers, H_USER_ID)),
    currentUpdateId: readHeader(headers, H_CURRENT_UPDATE_ID)?.toLowerCase() ?? null,
    embeddedUpdateId: readHeader(headers, H_EMBEDDED_UPDATE_ID)?.toLowerCase() ?? null,
    recentFailedUpdateIds: rawFailedIds ? parseSfvStringList(rawFailedIds) : [],
    extraParams: rawExtraParams ? parseSfvStringDictionary(rawExtraParams) : {},
    expectSignature: parseExpectSignature(readHeader(headers, H_EXPECT_SIGNATURE)),
    acceptsMultipart: accept.multipart,
    jsonError: readHeader(headers, H_JSON_ERROR) === 'true',
    fatalError: readHeader(headers, H_FATAL_ERROR),
  });
}
