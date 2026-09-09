import { contracts } from '@ota/contracts';
import * as schema from '@ota/db/schema/index';
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.ts';
import { getDeviceMetrics } from '../../services/device-metrics.ts';
import { handle } from './validate.ts';

/**
 * Per-install tracking, read side.
 *
 * Observability only. Nothing here is consulted by `selectUpdate` and nothing
 * ever should be — tracking is not targeting, and targeting stays a V2 non-goal
 * (spec §55). See D16 in `docs/decisions.md`.
 *
 * Mounted at the bare `/api/admin` prefix like `releaseRoutes`, so the paths
 * below are complete.
 */
export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.get(
  '/applications/:id/device-metrics',
  handle(contracts.devices.metrics, async (c, { query }) => {
    return c.json(
      await getDeviceMetrics(
        c.var.db,
        c.req.param('id')!,
        query,
        c.var.env.DEVICE_TRACKING_ENABLED,
        c.var.env.DEVICE_TRACKING_RETENTION_DAYS,
      ),
    );
  }),
);

const DAY_MS = 86_400_000;

/**
 * Map update ids to their release number for the whole application.
 *
 * One query rather than a join per row: the adoption table joins updates that
 * may no longer exist as variants (a deleted release), so a left join in every
 * aggregate would repeat the same lookup and still need the null handling.
 */
async function releaseNumbersByUpdateId(
  db: AppEnv['Variables']['db'],
  applicationId: string,
): Promise<Map<string, { releaseNumber: number; platform: string; runtimeVersion: string }>> {
  const rows = await db
    .select({
      updateId: schema.releaseVariants.updateId,
      releaseNumber: schema.releases.releaseNumber,
      platform: schema.releaseVariants.platform,
      runtimeVersion: schema.releaseVariants.runtimeVersion,
    })
    .from(schema.releaseVariants)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.releaseVariants.releaseId))
    .where(eq(schema.releases.applicationId, applicationId));

  return new Map(rows.map((r) => [r.updateId, r]));
}

deviceRoutes.get('/applications/:id/device-adoption', async (c) => {
  const applicationId = c.req.param('id');
  const db = c.var.db;
  const now = Date.now();

  const totals = await db
    .select({
      installs: sql<number>`count(*)`,
      activeLast24h: sql<number>`sum(case when ${schema.deviceInstalls.lastSeenAt} >= ${now - DAY_MS} then 1 else 0 end)`,
      activeLast7d: sql<number>`sum(case when ${schema.deviceInstalls.lastSeenAt} >= ${now - 7 * DAY_MS} then 1 else 0 end)`,
    })
    .from(schema.deviceInstalls)
    .where(eq(schema.deviceInstalls.applicationId, applicationId));

  // What each install is running right now.
  const running = await db
    .select({
      updateId: schema.deviceInstalls.currentUpdateId,
      n: sql<number>`count(*)`,
      runtimeVersion: sql<string | null>`max(${schema.deviceInstalls.runtimeVersion})`,
    })
    .from(schema.deviceInstalls)
    .where(eq(schema.deviceInstalls.applicationId, applicationId))
    .groupBy(schema.deviceInstalls.currentUpdateId);

  // The funnel halves, from the bounded event log.
  const funnel = await db
    .select({
      updateId: schema.deviceUpdateEvents.updateId,
      kind: schema.deviceUpdateEvents.kind,
      n: sql<number>`count(*)`,
    })
    .from(schema.deviceUpdateEvents)
    .where(eq(schema.deviceUpdateEvents.applicationId, applicationId))
    .groupBy(schema.deviceUpdateEvents.updateId, schema.deviceUpdateEvents.kind);

  const variants = await releaseNumbersByUpdateId(db, applicationId);

  const byUpdate = new Map<
    string,
    { running: number; served: number; confirmed: number; runtimeVersion: string | null }
  >();
  const bucket = (updateId: string) => {
    const existing = byUpdate.get(updateId);
    if (existing) return existing;
    const created = { running: 0, served: 0, confirmed: 0, runtimeVersion: null };
    byUpdate.set(updateId, created);
    return created;
  };

  for (const row of running) {
    // Installs that have never reported a current update id are real, but they
    // are not "on" any update, so they are not a row in this table.
    if (row.updateId) {
      const b = bucket(row.updateId);
      b.running = Number(row.n);
      b.runtimeVersion = row.runtimeVersion ?? null;
    }
  }
  for (const row of funnel) {
    if (row.kind === 'served') bucket(row.updateId).served = Number(row.n);
    else bucket(row.updateId).confirmed = Number(row.n);
  }

  return c.json({
    trackingEnabled: c.var.env.DEVICE_TRACKING_ENABLED,
    totals: {
      installs: Number(totals[0]?.installs ?? 0),
      activeLast24h: Number(totals[0]?.activeLast24h ?? 0),
      activeLast7d: Number(totals[0]?.activeLast7d ?? 0),
    },
    byUpdate: [...byUpdate.entries()]
      .map(([updateId, counts]) => {
        const variant = variants.get(updateId);
        // Embedded bundles are never published, so they never appear in
        // `release_variants` — fall back to the runtime version the installs
        // themselves reported. Installs sharing an update id come from one
        // build, so they agree on it.
        const { runtimeVersion: reported, ...rest } = counts;
        return {
          updateId,
          releaseNumber: variant?.releaseNumber ?? null,
          platform: (variant?.platform ?? null) as 'ios' | 'android' | null,
          runtimeVersion: variant?.runtimeVersion ?? reported ?? null,
          ...rest,
        };
      })
      // Highest release number first, unknown updates (embedded bundles) last.
      .sort((a, b) => (b.releaseNumber ?? -1) - (a.releaseNumber ?? -1)),
  });
});

deviceRoutes.get(
  '/applications/:id/devices',
  handle(contracts.devices.list, async (c, { query }) => {
    const applicationId = c.req.param('id')!;
    const db = c.var.db;

    const filters = [eq(schema.deviceInstalls.applicationId, applicationId)];
    if (query.platform) filters.push(eq(schema.deviceInstalls.platform, query.platform));
    if (query.channel) filters.push(eq(schema.deviceInstalls.channelName, query.channel));
    if (query.runtimeVersion) {
      filters.push(eq(schema.deviceInstalls.runtimeVersion, query.runtimeVersion));
    }
    if (query.updateId) filters.push(eq(schema.deviceInstalls.currentUpdateId, query.updateId));
    if (query.userId) filters.push(eq(schema.deviceInstalls.userId, query.userId));
    if (query.osVersion) filters.push(eq(schema.deviceInstalls.osVersion, query.osVersion));
    if (query.deviceBrand) {
      filters.push(eq(schema.deviceInstalls.deviceBrand, query.deviceBrand));
    }
    if (query.activeWithinDays) {
      filters.push(
        gte(
          schema.deviceInstalls.lastSeenAt,
          new Date(Date.now() - query.activeWithinDays * DAY_MS),
        ),
      );
    }
    const where = and(...filters);

    const [countRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.deviceInstalls)
      .where(where);

    const rows = await db
      .select()
      .from(schema.deviceInstalls)
      .where(where)
      .orderBy(desc(schema.deviceInstalls.lastSeenAt))
      .limit(query.limit)
      .offset(query.offset);

    const variants = await releaseNumbersByUpdateId(db, applicationId);

    return c.json({
      items: rows.map((r) => ({
        clientId: r.clientId,
        clientIdSource: r.clientIdSource,
        userId: r.userId,
        osVersion: r.osVersion,
        deviceBrand: r.deviceBrand,
        deviceModel: r.deviceModel,
        platform: r.platform,
        channelName: r.channelName,
        runtimeVersion: r.runtimeVersion,
        currentUpdateId: r.currentUpdateId,
        currentUpdateSince: r.currentUpdateSince?.toISOString() ?? null,
        currentReleaseNumber: r.currentUpdateId
          ? (variants.get(r.currentUpdateId)?.releaseNumber ?? null)
          : null,
        embeddedUpdateId: r.embeddedUpdateId,
        lastServedUpdateId: r.lastServedUpdateId,
        lastServedAt: r.lastServedAt?.toISOString() ?? null,
        requestCount: r.requestCount,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
      })),
      total: Number(countRow?.n ?? 0),
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

deviceRoutes.get(
  '/applications/:id/updates/:updateId/devices',
  handle(contracts.devices.recipients, async (c, { query }) => {
    const applicationId = c.req.param('id')!;
    const updateId = c.req.param('updateId')!;
    const db = c.var.db;

    // Pivot the event log to one row per install: an install appears once with
    // both halves of its funnel, rather than twice.
    const pivoted = db
      .select({
        clientId: schema.deviceUpdateEvents.clientId,
        platform: sql<'ios' | 'android'>`max(${schema.deviceUpdateEvents.platform})`.as(
          'recipient_platform',
        ),
        servedAt: sql<
          number | null
        >`max(case when ${schema.deviceUpdateEvents.kind} = 'served' then ${schema.deviceUpdateEvents.createdAt} end)`.as(
          'served_at',
        ),
        confirmedAt: sql<
          number | null
        >`max(case when ${schema.deviceUpdateEvents.kind} = 'confirmed' then ${schema.deviceUpdateEvents.createdAt} end)`.as(
          'confirmed_at',
        ),
      })
      .from(schema.deviceUpdateEvents)
      .where(
        and(
          eq(schema.deviceUpdateEvents.applicationId, applicationId),
          eq(schema.deviceUpdateEvents.updateId, updateId),
        ),
      )
      .groupBy(schema.deviceUpdateEvents.clientId)
      .as('recipients');

    const kindFilter =
      query.kind === 'served'
        ? isNotNull(pivoted.servedAt)
        : query.kind === 'confirmed'
          ? isNotNull(pivoted.confirmedAt)
          : undefined;
    const [counts] = await db
      .select({
        served: sql<number>`count(${pivoted.servedAt})`,
        confirmed: sql<number>`count(${pivoted.confirmedAt})`,
      })
      .from(pivoted);
    const [total] = await db.select({ n: sql<number>`count(*)` }).from(pivoted).where(kindFilter);
    const page = await db
      .select()
      .from(pivoted)
      .where(kindFilter)
      .orderBy(
        desc(sql`coalesce(${pivoted.servedAt}, ${pivoted.confirmedAt}, 0)`),
        asc(pivoted.clientId),
      )
      .limit(query.limit)
      .offset(query.offset);

    // Only the page needs the install row, for the user id, the device facts
    // and "still running".
    const installRows =
      page.length === 0
        ? []
        : await db
            .select({
              clientId: schema.deviceInstalls.clientId,
              clientIdSource: schema.deviceInstalls.clientIdSource,
              userId: schema.deviceInstalls.userId,
              osVersion: schema.deviceInstalls.osVersion,
              deviceBrand: schema.deviceInstalls.deviceBrand,
              deviceModel: schema.deviceInstalls.deviceModel,
              currentUpdateId: schema.deviceInstalls.currentUpdateId,
              lastSeenAt: schema.deviceInstalls.lastSeenAt,
            })
            .from(schema.deviceInstalls)
            .where(
              and(
                eq(schema.deviceInstalls.applicationId, applicationId),
                inArray(
                  schema.deviceInstalls.clientId,
                  page.map((r) => r.clientId),
                ),
              ),
            );
    const byClient = new Map(installRows.map((r) => [r.clientId, r]));

    return c.json({
      updateId,
      served: Number(counts?.served ?? 0),
      confirmed: Number(counts?.confirmed ?? 0),
      items: page.map((row) => {
        const install = byClient.get(row.clientId);
        return {
          clientId: row.clientId,
          clientIdSource: install?.clientIdSource ?? null,
          userId: install?.userId ?? null,
          osVersion: install?.osVersion ?? null,
          deviceBrand: install?.deviceBrand ?? null,
          deviceModel: install?.deviceModel ?? null,
          platform: row.platform,
          servedAt: row.servedAt === null ? null : new Date(row.servedAt).toISOString(),
          confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt).toISOString(),
          stillRunning: install?.currentUpdateId === updateId,
          lastSeenAt: install?.lastSeenAt.toISOString() ?? null,
        };
      }),
      total: Number(total?.n ?? 0),
      limit: query.limit,
      offset: query.offset,
    });
  }),
);
