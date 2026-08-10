import type { Platform } from '@oat/types';

/**
 * Update selection.
 *
 * `applicationId` is required and non-optional by design: the multi-application
 * isolation invariant says no update may be selected without an explicit owning
 * application, and making the parameter mandatory is what enforces it at the
 * type level. There must be no overload that omits it.
 */
export interface SelectUpdateInput {
  applicationId: string;
  channelName: string;
  platform: Platform;
  runtimeVersion: string;
  /** The update the device is currently running, lowercased. */
  currentUpdateId: string | null;
  /** The update embedded in the binary; required for `rollBackToEmbedded`. */
  embeddedUpdateId: string | null;
}

export type UpdateDecision =
  | {
      kind: 'update';
      updateId: string;
      /** The exact stored manifest string. */
      manifestJson: string;
      /** Standard base64 signature, or null if the variant was signed by no key. */
      manifestSignature: string | null;
      keyId: string | null;
    }
  | { kind: 'noUpdate'; reason: NoUpdateReason }
  | { kind: 'rollBackToEmbedded'; commitTime: Date };

export type NoUpdateReason =
  | 'no_channel'
  | 'no_deployment'
  | 'already_current'
  | 'already_embedded'
  | 'rollback_unavailable';
