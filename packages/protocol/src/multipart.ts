import type { MultipartPartName } from '@ota/types';
import { CT_JSON, H_CONTENT_DISPOSITION, H_CONTENT_TYPE } from './headers.ts';

/**
 * `multipart/mixed` writer.
 *
 * Hand-rolled on purpose. Web `FormData` emits `multipart/form-data` with an
 * opaque boundary and offers no way to attach a per-part `expo-signature`
 * header — and since signature validity depends on the exact part-body bytes,
 * we need full control over what goes on the wire.
 *
 * Layout (CRLF throughout, no preamble, no epilogue):
 *
 *   --{boundary}\r\n
 *   content-disposition: form-data; name="manifest"\r\n
 *   content-type: application/json\r\n
 *   expo-signature: sig="...", keyid="main"\r\n
 *   \r\n
 *   {body}\r\n
 *   --{boundary}--\r\n
 */

const CRLF = '\r\n';

export interface MultipartPart {
  name: MultipartPartName;
  body: string;
  contentType?: string;
  /** Additional part headers, e.g. `expo-signature`. */
  headers?: Record<string, string>;
}

/**
 * Generate a boundary.
 *
 * Hex only, so it can never collide with base64 payload content or require
 * quoting in the `content-type` parameter.
 */
export function generateBoundary(): string {
  return `oat${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
}

export function multipartContentType(boundary: string): string {
  return `multipart/mixed; boundary=${boundary}`;
}

export function buildMultipartBody(parts: MultipartPart[], boundary: string): Uint8Array {
  let out = '';

  for (const part of parts) {
    out += `--${boundary}${CRLF}`;
    out += `${H_CONTENT_DISPOSITION}: form-data; name="${part.name}"${CRLF}`;
    out += `${H_CONTENT_TYPE}: ${part.contentType ?? CT_JSON}${CRLF}`;
    for (const [name, value] of Object.entries(part.headers ?? {})) {
      out += `${name}: ${value}${CRLF}`;
    }
    out += CRLF;
    out += part.body;
    out += CRLF;
  }

  out += `--${boundary}--${CRLF}`;
  return new TextEncoder().encode(out);
}

/**
 * Extract a part body by name.
 *
 * Exists so tests can prove the round trip: build a response, pull the manifest
 * part back out, and verify its signature against the certificate. That is the
 * test which catches "signed one string, emitted another" — the failure mode
 * that is otherwise invisible until a device rejects the update.
 *
 * Intentionally simple: it does not handle nested multiparts or transfer
 * encodings, which this protocol never uses.
 */
export function extractPartBody(
  body: Uint8Array | string,
  boundary: string,
  name: MultipartPartName,
): string | null {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const segments = text.split(`--${boundary}`);

  for (const segment of segments) {
    if (segment === '' || segment.startsWith('--')) continue;

    const separator = segment.indexOf(CRLF + CRLF);
    if (separator === -1) continue;

    const rawHeaders = segment.slice(0, separator);
    if (!new RegExp(`name="${name}"`).test(rawHeaders)) continue;

    // Body runs to the trailing CRLF that precedes the next boundary marker.
    const rest = segment.slice(separator + 4);
    return rest.endsWith(CRLF) ? rest.slice(0, -2) : rest;
  }

  return null;
}

/** Parse the boundary out of a `multipart/mixed; boundary=...` content type. */
export function parseBoundary(contentType: string): string | null {
  const match = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return match?.[2] ?? null;
}
