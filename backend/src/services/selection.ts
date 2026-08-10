import type { OtaDatabase } from '@ota/db';
import { channels, deployments, releaseVariants } from '@ota/db';
import type { SelectUpdateInput, UpdateDecision } from '@ota/protocol';
import { and, eq } from 'drizzle-orm';

/**
 * Update selection.
 *
 * `applicationId` is a required field of {@link SelectUpdateInput} and every
 * query below filters on it. There is deliberately no variant of this function
 * that resolves an update from channel/platform/runtime alone — that is the
 * multi-application isolation invariant, and this is the only place it could be
 * broken.
 */
export async function selectUpdate(
  db: OtaDatabase,
  input: SelectUpdateInput,
): Promise<UpdateDecision> {
  const rows = await db
    .select({
      deploymentDirective: deployments.directive,
      directiveCommitTime: deployments.directiveCommitTime,
      updateId: releaseVariants.updateId,
      manifest: releaseVariants.manifest,
      manifestSignature: releaseVariants.manifestSignature,
      signingKeyId: releaseVariants.signingKeyId,
      variantRuntimeVersion: releaseVariants.runtimeVersion,
    })
    .from(deployments)
    .innerJoin(channels, eq(channels.id, deployments.channelId))
    .leftJoin(releaseVariants, eq(releaseVariants.id, deployments.releaseVariantId))
    .where(
      and(
        // All four, always. Never query by runtime version alone.
        eq(deployments.applicationId, input.applicationId),
        eq(channels.applicationId, input.applicationId),
        eq(channels.name, input.channelName),
        eq(deployments.platform, input.platform),
        eq(deployments.runtimeVersion, input.runtimeVersion),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { kind: 'noUpdate', reason: 'no_deployment' };

  if (row.deploymentDirective === 'rollBackToEmbedded') {
    // The client can only honour a rollback if it knows which update is
    // embedded in its binary; without that header the directive is meaningless.
    if (!input.embeddedUpdateId) {
      return { kind: 'noUpdate', reason: 'rollback_unavailable' };
    }
    // Already running the embedded bundle — nothing to do.
    if (input.currentUpdateId === input.embeddedUpdateId) {
      return { kind: 'noUpdate', reason: 'already_embedded' };
    }
    return {
      kind: 'rollBackToEmbedded',
      commitTime: row.directiveCommitTime ?? new Date(0),
    };
  }

  if (!row.updateId || !row.manifest) {
    return { kind: 'noUpdate', reason: 'no_deployment' };
  }

  // The device already has this exact update.
  if (input.currentUpdateId && input.currentUpdateId === row.updateId.toLowerCase()) {
    return { kind: 'noUpdate', reason: 'already_current' };
  }

  return {
    kind: 'update',
    updateId: row.updateId,
    manifestJson: row.manifest,
    manifestSignature: row.manifestSignature,
    keyId: row.signingKeyId,
  };
}
