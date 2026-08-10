export const PROTOCOL_ERROR_CODES = [
  'METHOD_NOT_ALLOWED',
  'INVALID_PROTOCOL_VERSION',
  'INVALID_PLATFORM',
  'MISSING_RUNTIME_VERSION',
  'NOT_ACCEPTABLE',
  'INVALID_SIGNATURE_REQUEST',
  'UNKNOWN_UPDATE_KEY',
  'DIRECTIVE_NOT_SUPPORTED',
  'SIGNING_UNAVAILABLE',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';

  constructor(
    readonly code: ProtocolErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolError };

export const ok = <T>(value: T): ProtocolResult<T> => ({ ok: true, value });

export const err = <T = never>(
  code: ProtocolErrorCode,
  status: number,
  message: string,
): ProtocolResult<T> => ({ ok: false, error: new ProtocolError(code, status, message) });
