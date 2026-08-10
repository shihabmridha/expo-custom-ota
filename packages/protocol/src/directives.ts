import type {
  ExpoDirective,
  NoUpdateAvailableDirective,
  RollBackToEmbeddedDirective,
} from '@oat/types';

/**
 * Update directives.
 *
 * Directives exist only in protocol version 1 and can only be delivered inside
 * a `multipart/mixed` response. When the client sent `expo-expect-signature`,
 * directives must be signed too — an unsigned directive makes the client throw
 * "No expo-signature header specified", which is the most common self-hosted
 * failure.
 */

export function noUpdateAvailableDirective(): NoUpdateAvailableDirective {
  return { type: 'noUpdateAvailable' };
}

/**
 * Instructs the client to discard downloaded updates and run the bundle
 * embedded in the binary.
 *
 * `commitTime` is required: the client treats the rollback as a pseudo-update
 * stamped with that time so it can compare recency against updates it already
 * holds. A rollback older than the running update is ignored.
 */
export function rollBackToEmbeddedDirective(commitTime: Date): RollBackToEmbeddedDirective {
  return {
    type: 'rollBackToEmbedded',
    parameters: { commitTime: commitTime.toISOString() },
  };
}

/** Serialize once; this is the string that gets signed and sent. */
export function serializeDirective(directive: ExpoDirective): string {
  return JSON.stringify(directive);
}
