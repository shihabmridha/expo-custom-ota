import { parseDictionary, parseList } from 'structured-headers';

/**
 * Structured Field Values (RFC 8941), scoped to the three shapes this protocol
 * actually uses.
 *
 * Parsing is delegated to `structured-headers` — quoted strings, bare booleans,
 * tokens and parameters are fiddly enough to be worth a dependency.
 *
 * Serialization is deliberately hand-rolled. We emit exactly one shape, and the
 * client is unforgiving about it, so producing the bytes ourselves keeps the
 * output provably identical to the reference server's
 * `sig="...", keyid="main"`.
 */

/** `structured-headers` represents each member as `[bareItem, parametersMap]`. */
type SfvMember = [unknown, Map<string, unknown>];

function isMember(value: unknown): value is SfvMember {
  return Array.isArray(value) && value.length === 2;
}

function bareValue(member: unknown): unknown {
  return isMember(member) ? member[0] : member;
}

/**
 * Parse an SFV dictionary into plain values, discarding parameters (nothing in
 * this protocol attaches parameters to dictionary members).
 *
 * Returns null rather than throwing: a malformed header from a client should
 * degrade, not 500.
 */
export function parseSfvDictionary(raw: string): Map<string, unknown> | null {
  try {
    const parsed = parseDictionary(raw);
    const out = new Map<string, unknown>();
    for (const [key, member] of parsed.entries()) out.set(key, bareValue(member));
    return out;
  } catch {
    return null;
  }
}

/** Parse an SFV list of strings, dropping any non-string members. */
export function parseSfvStringList(raw: string): string[] {
  try {
    return parseList(raw)
      .map(bareValue)
      .filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/** Parse an SFV dictionary whose values are all strings (e.g. `expo-extra-params`). */
export function parseSfvStringDictionary(raw: string): Record<string, string> {
  const dict = parseSfvDictionary(raw);
  if (!dict) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of dict.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Escape a string for an SFV `sf-string`: backslash and double-quote are the
 * only characters requiring escapes (RFC 8941 §4.1.6).
 */
function serializeSfvString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the `expo-signature` header value.
 *
 * Emits only `sig` and `keyid`. `alg` is optional and a mismatch merely logs on
 * the client, so omitting it removes a failure mode without losing anything.
 *
 * @param signature standard base64 **with** padding — not base64url
 * @param keyId must equal the client's `codeSigningMetadata.keyid` exactly
 */
export function serializeSignatureHeader(signature: string, keyId: string): string {
  return `sig=${serializeSfvString(signature)}, keyid=${serializeSfvString(keyId)}`;
}
