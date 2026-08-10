/**
 * Structured logging.
 *
 * JSON lines to stdout. Event names are a closed union so a typo fails to
 * compile rather than producing an unqueryable log stream.
 */

export const LOG_EVENTS = [
  'server_started',
  'application_created',
  'application_updated',
  'application_deleted',

  'release_uploaded',
  'release_import_started',
  'release_import_failed',
  'release_ready',

  'release_published',
  'release_promoted',
  'release_rollback_created',
  'rollback_to_embedded_set',

  'update_requested',
  'update_served',
  'no_update_available',
  'roll_back_to_embedded_served',
  'runtime_mismatch',

  'asset_served',
  'storage_failure',
  'database_failure',
  'signing_failure',

  'auth_login_succeeded',
  'auth_login_failed',
  'auth_logged_out',
  'rate_limit_exceeded',

  'request_failed',
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys that must never reach the log stream, at any nesting level.
 * Checked by name, so a new field called `password` is redacted by default
 * rather than by remembering to redact it.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'cookie',
  'authorization',
  'sessionsecret',
  'session_secret',
  'privatekey',
  'private_key',
  'privatekeypem',
  'secret',
  'r2secretaccesskey',
  'r2_secret_access_key',
]);

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(nested);
  }
  return out;
}

export interface Logger {
  debug(event: LogEvent, fields?: Record<string, unknown>): void;
  info(event: LogEvent, fields?: Record<string, unknown>): void;
  warn(event: LogEvent, fields?: Record<string, unknown>): void;
  error(event: LogEvent, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

export function createLogger(minLevel: LogLevel = 'info', bound: Record<string, unknown> = {}) {
  const write = (level: LogLevel, event: LogEvent, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(bound) as Record<string, unknown>),
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    const serialized = JSON.stringify(line);
    if (level === 'error' || level === 'warn') console.error(serialized);
    else console.log(serialized);
  };

  const logger: Logger = {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (extra) => createLogger(minLevel, { ...bound, ...extra }),
  };

  return logger;
}
