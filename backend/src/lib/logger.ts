import pino, { type Logger as PinoInstance } from 'pino';

/**
 * Structured logging powered by Pino.
 *
 * JSON lines output. Event names are a closed union so a typo fails to
 * compile rather than producing an unqueryable log stream.
 */

export const LOG_EVENTS = [
  'server_started',
  'applying_database_migrations',
  'migration_failed',

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
  'device_identity_missing',
  'device_tracking_failed',
  'extra_params_unparsable',

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

/**
 * Keys that must never reach the log stream.
 *
 * Pino's `redact.paths` matches literal paths, not key names at arbitrary
 * depth — unlike the hand-rolled recursive `redact()` this replaced, which
 * masked a key by name no matter how deeply it was nested. To approximate
 * that, each name is listed at the top level, one wildcard level (`*.x`,
 * e.g. a field nested under `error` or `body`) and two wildcard levels
 * (`*.*.x`, e.g. a field nested under `body.user`). A secret buried three or
 * more levels deep still leaks — keep bound fields shallow, or extend this
 * list with an explicit path if that ever happens.
 */
const REDACTED_KEY_NAMES = [
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
];

const REDACTED_PATHS = REDACTED_KEY_NAMES.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export interface Logger {
  debug(event: LogEvent, fields?: Record<string, unknown>): void;
  info(event: LogEvent, fields?: Record<string, unknown>): void;
  warn(event: LogEvent, fields?: Record<string, unknown>): void;
  error(event: LogEvent, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

export function createLogger(
  minLevel: LogLevel = 'info',
  bound: Record<string, unknown> = {},
): Logger {
  const pinoLogger: PinoInstance = pino({
    level: minLevel,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[redacted]',
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: bound,
  });

  return {
    debug: (event, fields) => pinoLogger.debug({ event, ...(fields ?? {}) }),
    info: (event, fields) => pinoLogger.info({ event, ...(fields ?? {}) }),
    warn: (event, fields) => pinoLogger.warn({ event, ...(fields ?? {}) }),
    error: (event, fields) => pinoLogger.error({ event, ...(fields ?? {}) }),
    child: (extra) => createLogger(minLevel, { ...bound, ...extra }),
  };
}
