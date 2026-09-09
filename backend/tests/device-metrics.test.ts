import { beforeEach, expect, test } from 'bun:test';
import { deviceMetricsQuerySchema, deviceMetricsSchema } from '@ota/contracts';
import { deployments, deviceInstalls } from '@ota/db';
import { eq, lt } from 'drizzle-orm';
import { getDeviceMetrics } from '../src/services/device-metrics.ts';
import { createMigratedDb, MemoryStorage, seedApplication } from './helpers.ts';

const DAY = 86_400_000;
const now = new Date('2026-09-09T12:00:00Z');
let db: ReturnType<typeof createMigratedDb>;
let seeded: Awaited<ReturnType<typeof seedApplication>>;
beforeEach(async () => {
  db = createMigratedDb();
  seeded = await seedApplication(db, new MemoryStorage(), {
    slug: 'metrics',
    updateKey: 'metrics',
  });
});
async function install(overrides: Partial<typeof deviceInstalls.$inferInsert> = {}) {
  const row = {
    applicationId: seeded.applicationId,
    clientId: crypto.randomUUID(),
    clientIdSource: 'eas' as const,
    platform: 'android' as const,
    channelName: 'production',
    runtimeVersion: '1.0.0',
    currentUpdateId: seeded.updateId,
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
  await db.insert(deviceInstalls).values(row);
  return row;
}
const metrics = (query = {}, enabled = true) =>
  getDeviceMetrics(
    db,
    seeded.applicationId,
    deviceMetricsQuerySchema.parse(query),
    enabled,
    90,
    now,
  );

test('counts install identities, including embedded and missing IDs in the denominator', async () => {
  await install();
  await install({ clientIdSource: 'extra' });
  await install({ currentUpdateId: 'embedded' });
  await install({ currentUpdateId: null });
  await install({ clientIdSource: 'user' });
  await install({ lastSeenAt: new Date(now.getTime() - 8 * DAY) });
  const result = await metrics();
  expect(deviceMetricsSchema.safeParse(result).success).toBe(true);
  expect(result.groups[0]).toMatchObject({
    activeEligible: 4,
    activeOnTarget: 2,
    unknownCurrentUpdate: 1,
    adoptionPercent: 50,
  });
  expect(result.userFallbackRecords).toBe(1);
  expect(result.inactivity.within7d).toBe(4);
  expect(result.inactivity.over7Through30d).toBe(1);
});

test('separates cohorts and applications and applies exact filters', async () => {
  const other = await seedApplication(db, new MemoryStorage(), {
    slug: 'other',
    updateKey: 'other',
  });
  await install({ applicationId: other.applicationId });
  await install();
  await install({ channelName: 'staging' });
  await install({ platform: 'ios' });
  await install({ runtimeVersion: '2.0.0' });
  expect((await metrics()).groups).toHaveLength(4);
  const result = await metrics({
    channel: 'production',
    platform: 'android',
    runtimeVersion: '1.0.0',
  });
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]?.activeEligible).toBe(1);
  expect(result.inactivity.within7d).toBe(1);
  expect((await metrics({ channel: 'missing' })).groups).toEqual([]);
});

test('distinguishes null adoption, zero adoption, and rollback deployments', async () => {
  expect((await metrics()).groups[0]).toMatchObject({ activeEligible: 0, adoptionPercent: null });
  await install({ currentUpdateId: null });
  expect((await metrics()).groups[0]?.adoptionPercent).toBe(0);
  await db
    .update(deployments)
    .set({ releaseVariantId: null, directive: 'rollBackToEmbedded' })
    .where(eq(deployments.applicationId, seeded.applicationId));
  expect((await metrics()).groups[0]).toMatchObject({
    deploymentState: 'rollback',
    adoptionPercent: null,
  });
  await db.delete(deployments).where(eq(deployments.applicationId, seeded.applicationId));
  expect((await metrics()).groups[0]).toMatchObject({
    deploymentState: 'none',
    adoptionPercent: null,
  });
});

test('inactivity boundaries are exclusive and independent of the adoption window', async () => {
  for (const age of [0, 7 * DAY, 7 * DAY + 1, 30 * DAY, 30 * DAY + 1, 60 * DAY, 60 * DAY + 1]) {
    await install({ lastSeenAt: new Date(now.getTime() - age) });
  }
  const result = await metrics({ activeWithinDays: 1 });
  expect(result.groups[0]?.activeEligible).toBe(1);
  expect(result.inactivity).toEqual({
    within7d: 2,
    over7Through30d: 2,
    over30Through60d: 2,
    over60d: 1,
  });
  expect((await metrics()).groups[0]?.activeEligible).toBe(2);
  expect((await metrics({ activeWithinDays: 30 })).groups[0]?.activeEligible).toBe(4);
});

test('returning installs and pruning change retained observations without history backfill', async () => {
  const row = await install({ lastSeenAt: new Date(now.getTime() - 91 * DAY) });
  expect((await metrics()).inactivity.over60d).toBe(1);
  await db
    .update(deviceInstalls)
    .set({ lastSeenAt: now })
    .where(eq(deviceInstalls.clientId, row.clientId));
  expect((await metrics()).inactivity.within7d).toBe(1);
  await install({ lastSeenAt: new Date(now.getTime() - 91 * DAY) });
  await db
    .delete(deviceInstalls)
    .where(lt(deviceInstalls.lastSeenAt, new Date(now.getTime() - 90 * DAY)));
  expect((await metrics()).inactivity.over60d).toBe(0);
  expect((await metrics({}, false)).trackingEnabled).toBe(false);
});
