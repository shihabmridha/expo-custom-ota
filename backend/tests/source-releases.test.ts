import { beforeEach, expect, test } from 'bun:test';
import { deviceListSchema, deviceSourceGroupsSchema, releaseDetailSchema } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import type { SourceMetadata } from '@ota/types';
import { eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { createAdmin } from '../src/services/auth.ts';
import {
  createMigratedDb,
  createTestApp,
  deviceHeaders,
  MemoryStorage,
  type SeededApplication,
  seedApplication,
} from './helpers.ts';

let db: OtaDatabase;
let app: ReturnType<typeof createTestApp>['app'];
let seeded: SeededApplication;
let cookie: string;
const embedded = 'aaaaaaaa-1111-4111-8111-111111111111';
const otherEmbedded = 'bbbbbbbb-2222-4222-8222-222222222222';
const metadata: SourceMetadata = {
  schemaVersion: 1,
  sourceRevision: `1.0.0+${'a'.repeat(40)}`,
  gitCommit: 'a'.repeat(40),
  application: 'xyz.sources.mobile',
  environment: 'production',
  platform: 'android',
  runtimeVersion: '1.0.0',
  appVersion: '1.0.0',
  nativeVersionCode: 1,
  toolchain: {
    bun: '1.4.0',
    node: 'v24.0.0',
    expo: '57.0.19',
    reactNative: '0.86.3',
    expoUpdates: '57.0.21',
  },
  publicConfigDigest: 'b'.repeat(64),
};

beforeEach(async () => {
  db = createMigratedDb();
  const storage = new MemoryStorage();
  app = createTestApp(db, storage).app;
  seeded = await seedApplication(db, storage, { slug: 'sources', updateKey: 'ota_sources' });
  await createAdmin(db, { email: 'sources@example.com', password: 'correct-horse-battery-staple' });
  const response = await app.request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'sources@example.com',
      password: 'correct-horse-battery-staple',
    }),
  });
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});

function poll(
  client: string,
  current: string | null,
  source = metadata.sourceRevision,
  sourceUpdate: string | null = current,
  headers: Record<string, string | null> = {},
) {
  return app.request('/api/v1/updates/ota_sources', {
    headers: deviceHeaders(client, {
      'expo-current-update-id': current,
      'expo-embedded-update-id': embedded,
      'expo-extra-params': sourceUpdate
        ? `source-revision="${source}", source-update-id="${sourceUpdate}"`
        : null,
      ...headers,
    }),
  });
}

async function groups(query = '') {
  const response = await app.request(
    `/api/admin/applications/${seeded.applicationId}/device-source-groups${query}`,
    { headers: { cookie } },
  );
  expect(response.status).toBe(200);
  return deviceSourceGroupsSchema.parse(await response.json()).groups;
}

function archive(source: unknown = metadata) {
  const files: Record<string, Uint8Array> = {
    'metadata.json': strToU8(
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: {
          android: { bundle: '_expo/static/js/android/index-source.hbc', assets: [] },
        },
      }),
    ),
    'expoConfig.json': strToU8(
      JSON.stringify({
        version: '1.0.0',
        runtimeVersion: '1.0.0',
        android: { package: metadata.application, versionCode: 1 },
      }),
    ),
    '_expo/static/js/android/index-source.hbc': strToU8('globalThis.sourceRelease = "fixture";'),
  };
  if (source !== null) files['releaseMetadata.json'] = strToU8(JSON.stringify(source));
  return zipSync(files);
}

async function upload(source: unknown = metadata) {
  return app.request(`/api/admin/applications/${seeded.applicationId}/releases/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/zip' },
    body: archive(source),
  });
}

test('upload retains source metadata, and rollback copies it while minting new identities', async () => {
  const imported = await upload();
  expect(imported.status).toBe(201);
  const { releaseId } = (await imported.json()) as { releaseId: string };
  const detail = releaseDetailSchema.parse(
    await (await app.request(`/api/admin/releases/${releaseId}`, { headers: { cookie } })).json(),
  );
  expect(detail.sourceMetadata).toEqual(metadata);
  expect(detail.sourceRevision).toBe(metadata.sourceRevision);
  const rollback = await app.request(`/api/admin/releases/${releaseId}/rollback`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'production' }),
  });
  expect(rollback.status).toBe(200);
  const rolled = (await rollback.json()) as {
    releaseId: string;
    deployments: { updateId: string }[];
  };
  expect(rolled.releaseId).not.toBe(releaseId);
  expect(rolled.deployments[0]!.updateId).not.toBe(detail.variants[0]!.updateId);
  const rollbackDetail = releaseDetailSchema.parse(
    await (
      await app.request(`/api/admin/releases/${rolled.releaseId}`, { headers: { cookie } })
    ).json(),
  );
  expect(rollbackDetail.sourceMetadata).toEqual(metadata);
  expect(rollbackDetail.rollbackOfReleaseId).toBe(releaseId);
});

test('rejects malformed or mismatched source metadata and accepts legacy archives', async () => {
  for (const source of [
    { ...metadata, sourceRevision: 'x'.repeat(129) },
    { ...metadata, sourceRevision: 'contains spaces' },
    { ...metadata, runtimeVersion: 'different' },
    { ...metadata, application: 'wrong.application' },
    { ...metadata, nativeVersionCode: 2 },
    { ...metadata, password: 'must-not-be-stored' },
  ]) {
    const response = await upload(source);
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  const legacy = await upload(null);
  expect(legacy.status).toBe(201);
  const { releaseId } = (await legacy.json()) as { releaseId: string };
  const detail = releaseDetailSchema.parse(
    await (await app.request(`/api/admin/releases/${releaseId}`, { headers: { cookie } })).json(),
  );
  expect(detail.sourceRevision).toBeNull();
});

test('groups two embedded installs with an OTA install, without changing adoption proof', async () => {
  await db
    .update(schema.releases)
    .set({ sourceRevision: metadata.sourceRevision, sourceMetadata: metadata })
    .where(eq(schema.releases.id, seeded.releaseId));
  await poll('apk', embedded);
  await poll('play', embedded);
  await poll('ota', embedded);
  await poll('ota', seeded.updateId, 'incorrect-client-label');
  const result = await groups();
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ sourceRevision: metadata.sourceRevision, installs: 3 });
  expect(result[0]!.updates).toContainEqual({
    updateId: embedded,
    launchKind: 'embedded',
    installs: 2,
  });
  expect(result[0]!.updates).toContainEqual({
    updateId: seeded.updateId,
    launchKind: 'downloaded',
    installs: 1,
  });
  const events = await db.select().from(schema.deviceUpdateEvents);
  expect(events.filter((event) => event.kind === 'confirmed')).toMatchObject([
    { clientId: 'ota', updateId: seeded.updateId },
  ]);
  const list = deviceListSchema.parse(
    await (
      await app.request(`/api/admin/applications/${seeded.applicationId}/devices`, {
        headers: { cookie },
      })
    ).json(),
  );
  expect(list.items.every((install) => install.sourceRevision === metadata.sourceRevision)).toBe(
    true,
  );
});

test('clears a stale association during native upgrade, missing params, and rollback', async () => {
  await poll('native', embedded);
  expect((await groups())[0]!.sourceRevision).toBe(metadata.sourceRevision);
  await poll('native', otherEmbedded, metadata.sourceRevision, embedded, {
    'expo-embedded-update-id': otherEmbedded,
  });
  expect((await groups())[0]!.sourceRevision).toBeNull();
  await poll('native', otherEmbedded, metadata.sourceRevision, otherEmbedded, {
    'expo-embedded-update-id': otherEmbedded,
  });
  expect((await groups())[0]!.sourceRevision).toBe(metadata.sourceRevision);
  await poll('native', otherEmbedded, metadata.sourceRevision, null);
  expect((await groups())[0]!.sourceRevision).toBeNull();
  await poll('native', embedded, metadata.sourceRevision, otherEmbedded);
  expect((await groups())[0]!.sourceRevision).toBeNull();
});

test('server-owned unknown provenance overrides client metadata for known OTA UUIDs', async () => {
  await poll('legacy', seeded.updateId);
  expect((await groups())[0]!.sourceRevision).toBeNull();
  const events = await db.select().from(schema.deviceUpdateEvents);
  expect(events.filter((event) => event.kind === 'confirmed')).toHaveLength(0);
});

test('native-only revisions and unknown installs are scoped by channel, platform, runtime and application', async () => {
  await poll('native', embedded);
  await poll('staging', embedded, metadata.sourceRevision, embedded, {
    'expo-channel-name': 'staging',
  });
  await poll('ios', embedded, metadata.sourceRevision, embedded, { 'expo-platform': 'ios' });
  await poll('runtime', embedded, metadata.sourceRevision, embedded, {
    'expo-runtime-version': '2.0.0',
  });
  await poll('unknown', null);
  const other = await seedApplication(db, new MemoryStorage(), {
    slug: 'other',
    updateKey: 'ota_other',
  });
  await app.request('/api/v1/updates/ota_other', {
    headers: deviceHeaders('other', { 'expo-current-update-id': embedded }),
  });
  const result = await groups();
  expect(result.reduce((sum, group) => sum + group.installs, 0)).toBe(5);
  expect(result).toHaveLength(5);
  expect(await groups('?channel=production&platform=android&runtimeVersion=1.0.0')).toHaveLength(2);
  const otherResponse = await app.request(
    `/api/admin/applications/${other.applicationId}/device-source-groups`,
    { headers: { cookie } },
  );
  expect(deviceSourceGroupsSchema.parse(await otherResponse.json()).groups[0]!.installs).toBe(1);
  await db.update(schema.deviceInstalls).set({ lastSeenAt: new Date(Date.now() - 8 * 86_400_000) });
  expect(await groups()).toHaveLength(0);
});

test('source grouping requires authentication', async () => {
  const response = await app.request(
    `/api/admin/applications/${seeded.applicationId}/device-source-groups`,
  );
  expect(response.status).toBe(401);
});

test('source groups exclude user fallback identities while the record list retains them', async () => {
  await poll('native', embedded);
  await poll('fallback', embedded, metadata.sourceRevision, embedded, {
    'eas-client-id': null,
    'x-ota-user-id': 'shared-user',
  });
  expect((await groups())[0]!.installs).toBe(1);
  const list = deviceListSchema.parse(
    await (
      await app.request(`/api/admin/applications/${seeded.applicationId}/devices`, {
        headers: { cookie },
      })
    ).json(),
  );
  expect(list.total).toBe(2);
  expect(list.items.some((install) => install.clientIdSource === 'user')).toBe(true);
});
