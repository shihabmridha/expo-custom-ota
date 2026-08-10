import type { ExpoDirective, ExpoExtensions } from '@ota/types';
import { serializeDirective } from './directives.ts';
import type { ProtocolError } from './errors.ts';
import {
  CT_EXPO_JSON,
  CT_JSON,
  H_CACHE_CONTROL,
  H_CONTENT_TYPE,
  H_PROTOCOL_VERSION,
  H_SFV_VERSION,
  H_SIGNATURE,
  MANIFEST_CACHE_CONTROL,
  PROTOCOL_VERSION_1,
  SFV_VERSION,
} from './headers.ts';
import {
  buildMultipartBody,
  generateBoundary,
  type MultipartPart,
  multipartContentType,
} from './multipart.ts';
import type { Signer } from './signature.ts';

/**
 * HTTP responses, expressed as plain data.
 *
 * The package deliberately does not construct `Response` objects — the backend
 * has a small adapter — so nothing here depends on an HTTP framework and every
 * byte is directly assertable in tests.
 */
export interface ProtocolHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

function baseHeaders(): Record<string, string> {
  return {
    [H_PROTOCOL_VERSION]: PROTOCOL_VERSION_1,
    [H_SFV_VERSION]: SFV_VERSION,
    [H_CACHE_CONTROL]: MANIFEST_CACHE_CONTROL,
  };
}

export interface UpdateResponseInput {
  /** The exact stored manifest string. Never re-serialize it. */
  manifestJson: string;
  /** Pre-computed `expo-signature` header value, or null when unsigned. */
  signatureHeader?: string | null;
  /** Per-asset request headers, keyed by `asset.key`. Omitted when empty. */
  assetRequestHeaders?: ExpoExtensions['assetRequestHeaders'];
}

/** Build a `multipart/mixed` response carrying a manifest. */
export function buildUpdateResponse(input: UpdateResponseInput): ProtocolHttpResponse {
  const boundary = generateBoundary();

  const parts: MultipartPart[] = [
    {
      name: 'manifest',
      body: input.manifestJson,
      contentType: CT_JSON,
      ...(input.signatureHeader ? { headers: { [H_SIGNATURE]: input.signatureHeader } } : {}),
    },
  ];

  const assetRequestHeaders = input.assetRequestHeaders ?? {};
  if (Object.keys(assetRequestHeaders).length > 0) {
    parts.push({
      name: 'extensions',
      body: JSON.stringify({ assetRequestHeaders } satisfies ExpoExtensions),
      contentType: CT_JSON,
    });
  }

  return {
    status: 200,
    headers: { ...baseHeaders(), [H_CONTENT_TYPE]: multipartContentType(boundary) },
    body: buildMultipartBody(parts, boundary),
  };
}

/**
 * Build a `multipart/mixed` response carrying a directive.
 *
 * `signer` must be supplied whenever the request sent `expo-expect-signature`.
 */
export async function buildDirectiveResponse(
  directive: ExpoDirective,
  signer: Signer | null,
): Promise<ProtocolHttpResponse> {
  const boundary = generateBoundary();
  const body = serializeDirective(directive);
  const signatureHeader = signer ? await signer.signHeader(body) : null;

  return {
    status: 200,
    headers: { ...baseHeaders(), [H_CONTENT_TYPE]: multipartContentType(boundary) },
    body: buildMultipartBody(
      [
        {
          name: 'directive',
          body,
          contentType: CT_JSON,
          ...(signatureHeader ? { headers: { [H_SIGNATURE]: signatureHeader } } : {}),
        },
      ],
      boundary,
    ),
  };
}

/**
 * Bare-JSON manifest response, for protocol version 0 clients.
 *
 * This is the one response structure where `expo-signature` is a top-level
 * response header rather than a part header.
 */
export function buildBareManifestResponse(input: UpdateResponseInput): ProtocolHttpResponse {
  return {
    status: 200,
    headers: {
      ...baseHeaders(),
      [H_PROTOCOL_VERSION]: '0',
      [H_CONTENT_TYPE]: CT_EXPO_JSON,
      ...(input.signatureHeader ? { [H_SIGNATURE]: input.signatureHeader } : {}),
    },
    body: new TextEncoder().encode(input.manifestJson),
  };
}

/**
 * Error response.
 *
 * Real clients send `expo-json-error: true` and expect a JSON body; the plain
 * text fallback exists for curl and the dashboard simulator.
 */
export function buildErrorResponse(error: ProtocolError, jsonError: boolean): ProtocolHttpResponse {
  const body = jsonError
    ? JSON.stringify({ error: error.code, message: error.message })
    : `${error.code}: ${error.message}`;

  return {
    status: error.status,
    headers: {
      ...baseHeaders(),
      [H_CONTENT_TYPE]: jsonError ? CT_JSON : 'text/plain; charset=utf-8',
    },
    body: new TextEncoder().encode(body),
  };
}
