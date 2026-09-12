import { sourceRevisionSchema } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import { deviceInstalls, deviceUpdateEvents } from '@ota/db';
import { type ExpoUpdateRequest, P_INSTALL_ID, sanitizeIdentifier } from '@ota/protocol';
import type { DeviceClientIdSource } from '@ota/types';
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from '../lib/logger.ts';
import type { TrackingDiagnostics } from '../lib/tracking-diagnostics.ts';

/**
 * Per-install update tracking.
 *
 * Departs from spec §44's "no device identifiers" — see D16 in
 * `docs/decisions.md`. Nothing here may throw into the update path: an
 * installed app staying updatable matters more than a row.
 *
 * The design has to satisfy three constraints at once — no read-modify-write
 * and no transactions (D3), event growth bounded independently of poll
 * frequency, and never breaking delivery. It does that with two mechanisms
 * instead of a read:
 *
 *   1. Every event append is `ON CONFLICT DO NOTHING` against a unique index,
 *      so "no duplicate events" is a property of the database, exactly as
 *      `deployments_target_unique` makes concurrent publishes deterministic.
 *   2. `RETURNING` on the state upsert hands back the post-write row. That is
 *      the write's own output, not a second statement, so the confirmation gate
 *      costs nothing and cannot race with itself.
 *
 * Known, accepted semantic limits:
 *
 * - An install served A → B → A logs `served(A)` once. The event log means
 *   "first time this install saw update X", not a re-serve log; `lastServedAt`
 *   and `requestCount` on the state row carry recency. This is the price of
 *   bounded growth and is the right trade.
 * - An install that took an update before this feature shipped, or whose
 *   `served` row has since been pruned, never emits `confirmed`. "What is it
 *   running" is still answered by `device_installs.current_update_id` — the two
 *   tables have separate jobs.
 * - There is no `rolled_back` kind. The kill switch is already audited in
 *   `deployment_events`, and a third kind for an update id we never issued
 *   would muddy the served/confirmed funnel.
 */

export interface DeviceIdentity {
  clientId: string;
  source: DeviceClientIdSource;
}

/**
 * Extra-param keys accepted as an install id, in order.
 *
 * All lowercase because they have to be: `expo-extra-params` is a Structured
 * Field dictionary, and RFC 8941 restricts keys to lowercase. A camelCase
 * `installId` is not merely unconventional, it fails to parse and the whole
 * key/value pair vanishes — so documenting one would hand people a fallback
 * that silently never fires. `install-id` is the form to document; `installid`
 * is accepted for anyone who writes it closed-up.
 */
const INSTALL_ID_PARAM_KEYS = [P_INSTALL_ID, 'installid'] as const;

/**
 * Resolve who is asking, most specific first.
 *
 * `eas-client-id` is sent by every real `expo-updates` client and is per
 * install. The `install-id` extra param is the runtime-settable fallback an app
 * can populate with `Updates.setExtraParamAsync` when tier 1 is unavailable.
 * The user id (`x-ota-user-id` header or `user-id` extra param — the parser has
 * already merged them) is the last resort and is deliberately coarse: it keys one row
 * per *user*, collapsing their devices, which is why it ranks below the others
 * rather than beside them. `clientIdSource` records which tier won so the
 * dashboard can label the row honestly.
 */
export function resolveDeviceIdentity(request: ExpoUpdateRequest): DeviceIdentity | null {
  if (request.easClientId) return { clientId: request.easClientId, source: 'eas' };

  for (const key of INSTALL_ID_PARAM_KEYS) {
    const installId = sanitizeIdentifier(request.extraParams[key] ?? null);
    if (installId) return { clientId: installId, source: 'extra' };
  }

  if (request.userId) return { clientId: `user:${request.userId}`, source: 'user' };

  return null;
}

export interface DeviceTrackingInput {
  applicationId: string;
  request: ExpoUpdateRequest;
  /** Resolved channel, including the application-default fallback. */
  channelName: string;
  /** Set ONLY when a manifest was actually handed out. */
  servedUpdateId: string | null;
}

export async function recordDeviceUpdate(
  db: OtaDatabase,
  logger: Logger,
  enabled: boolean,
  input: DeviceTrackingInput,
  now = new Date(),
  diagnostics?: TrackingDiagnostics,
): Promise<void> {
  if (!enabled) return;

  const identity = resolveDeviceIdentity(input.request);
  if (!identity) {
    // Debug rather than warn: against a client that genuinely sends no
    // identifier this fires on every single request and would drown the log.
    logger.debug('device_identity_missing', {
      applicationId: input.applicationId,
      platform: input.request.platform,
    });
    return;
  }

  const { request } = input;
  const reportedSource = sourceRevisionSchema.safeParse(request.extraParams['source-revision']);
  const sourceRevision =
    request.currentUpdateId &&
    request.extraParams['source-update-id']?.toLowerCase() === request.currentUpdateId &&
    reportedSource.success
      ? reportedSource.data
      : null;

  try {
    // 1. State. One statement: creates or updates, and RETURNING hands back the
    //    post-write row — the write's output, not a read.
    const rows = await db
      .insert(deviceInstalls)
      .values({
        applicationId: input.applicationId,
        clientId: identity.clientId,
        clientIdSource: identity.source,
        userId: request.userId,
        osVersion: request.osVersion,
        deviceBrand: request.deviceBrand,
        deviceModel: request.deviceModel,
        platform: request.platform,
        channelName: input.channelName,
        runtimeVersion: request.runtimeVersion,
        currentUpdateId: request.currentUpdateId,
        sourceRevision,
        currentUpdateSince: request.currentUpdateId ? now : null,
        embeddedUpdateId: request.embeddedUpdateId,
        lastServedUpdateId: input.servedUpdateId,
        lastServedAt: input.servedUpdateId ? now : null,
        confirmedUpdateId: null,
        requestCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [deviceInstalls.applicationId, deviceInstalls.clientId],
        set: {
          // Mutable facts: last writer wins.
          clientIdSource: sql`excluded.client_id_source`,
          platform: sql`excluded.platform`,
          channelName: sql`excluded.channel_name`,
          runtimeVersion: sql`excluded.runtime_version`,
          currentUpdateId: sql`excluded.current_update_id`,
          sourceRevision: sql`excluded.source_revision`,
          // `IS NOT` is SQLite's null-safe "is distinct from", so an install
          // that *stops* reporting an update id counts as a change rather than
          // silently keeping a stale timestamp.
          currentUpdateSince: sql`CASE
              WHEN excluded.current_update_id IS NOT ${deviceInstalls.currentUpdateId}
              THEN excluded.last_seen_at
              ELSE ${deviceInstalls.currentUpdateSince} END`,
          // Sticky: a client that stops sending one of these keeps the last
          // known value rather than nulling out a fact we already learned.
          embeddedUpdateId: sql`coalesce(excluded.embedded_update_id, ${deviceInstalls.embeddedUpdateId})`,
          userId: sql`coalesce(excluded.user_id, ${deviceInstalls.userId})`,
          osVersion: sql`coalesce(excluded.os_version, ${deviceInstalls.osVersion})`,
          deviceBrand: sql`coalesce(excluded.device_brand, ${deviceInstalls.deviceBrand})`,
          deviceModel: sql`coalesce(excluded.device_model, ${deviceInstalls.deviceModel})`,
          lastServedUpdateId: sql`coalesce(excluded.last_served_update_id, ${deviceInstalls.lastServedUpdateId})`,
          lastServedAt: sql`coalesce(excluded.last_served_at, ${deviceInstalls.lastServedAt})`,
          lastSeenAt: sql`excluded.last_seen_at`,
          requestCount: sql`${deviceInstalls.requestCount} + 1`,
          // `firstSeenAt` and `confirmedUpdateId` are absent on purpose: not
          // listing them here is exactly what preserves them.
        },
      })
      .returning({
        id: deviceInstalls.id,
        currentUpdateId: deviceInstalls.currentUpdateId,
        confirmedUpdateId: deviceInstalls.confirmedUpdateId,
      });

    const install = rows[0];
    if (!install) return;

    // 2. Served. Only when a manifest actually went out, and idempotent: an
    //    install that re-fetches the same update after a failed launch does not
    //    append a second row.
    if (input.servedUpdateId) {
      await db
        .insert(deviceUpdateEvents)
        .values({
          applicationId: input.applicationId,
          clientId: identity.clientId,
          updateId: input.servedUpdateId,
          kind: 'served',
          platform: request.platform,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [
            deviceUpdateEvents.applicationId,
            deviceUpdateEvents.clientId,
            deviceUpdateEvents.updateId,
            deviceUpdateEvents.kind,
          ],
        });
    }

    // 3. Confirmed. The gate is what keeps a steady-state poll at ONE write:
    //    once processed, current == confirmed and nothing below runs again.
    const current = install.currentUpdateId;
    if (!current || current === install.confirmedUpdateId) return;

    // A confirmation only counts as install proof if WE served that update to
    // THIS install. Without the `WHERE EXISTS`, an install reporting the bundle
    // embedded in its binary — an id this server never issued — would register
    // as adoption. The clause is load-bearing for correctness, not a filter for
    // tidiness: do not "simplify" it away. The
    // "reporting an update we never served appends no confirmed event" test in
    // `backend/tests/device-tracking.test.ts` is what makes its removal loud.
    await db.run(sql`
      INSERT INTO device_update_events
        (id, application_id, client_id, update_id, kind, platform, created_at)
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, ${identity.clientId},
             ${current}, 'confirmed', ${request.platform}, ${now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM device_update_events s
         WHERE s.application_id = ${input.applicationId}
           AND s.client_id      = ${identity.clientId}
           AND s.update_id      = ${current}
           AND s.kind           = 'served')
      ON CONFLICT DO NOTHING
    `);

    // Advance the gate. Compare-and-swap on `current_update_id` so an install
    // that moved again between statement 1 and here is not clobbered — its next
    // poll finds the gate still open and retries, hitting DO NOTHING on the
    // event that was already written.
    //
    // Advanced unconditionally, including when the EXISTS above matched
    // nothing: this column means "already processed", not "confirmed as ours".
    // Without that, an install running an embedded bundle would retry three
    // writes on every poll, forever.
    await db
      .update(deviceInstalls)
      .set({ confirmedUpdateId: current })
      .where(and(eq(deviceInstalls.id, install.id), eq(deviceInstalls.currentUpdateId, current)));
  } catch {
    diagnostics?.failure('device', input.applicationId);
  }
}
