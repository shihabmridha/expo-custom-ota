import { beforeEach, describe, expect, test } from 'bun:test';
import type { DeviceAdoption, DeviceList, DeviceRecipients } from '@ota/contracts';
import { deviceMetricsSchema } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
import { deviceInstalls, deviceUpdateEvents } from '@ota/db';
import { eq } from 'drizzle-orm';
import { createAdmin } from '../src/services/auth.ts';
import {
  clientHeaders,
  createMigratedDb,
  createTestApp,
  deviceHeaders,
  MemoryStorage,
  type SeededApplication,
  seedApplication,
} from './helpers.ts';

let db: OtaDatabase;
let app: ReturnType<typeof createTestApp>['app'];
let storage: MemoryStorage;
let seeded: SeededApplication;

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';
const DEVICE_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const DEVICE_B = 'bbbbbbbb-2222-4000-8000-000000000002';
const DEVICE_C = 'cccccccc-3333-4000-8000-000000000003';
/** An embedded bundle's update id — never published, so never in `release_variants`. */
const EMBEDDED_UPDATE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  app = createTestApp(db, storage).app;
  await createAdmin(db, { email: EMAIL, password: PASSWORD, name: 'Admin' });
  seeded = await seedApplication(db, storage, { slug: 'track', updateKey: 'ota_track' });
});

async function login(): Promise<string> {
  const response = await app.fetch(
    new Request('http://localhost/api/admin/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

async function device(headers: Headers) {
  return app.fetch(new Request('http://localhost/api/v1/updates/ota_track', { headers }));
}

async function admin(path: string, cookie: string) {
  return app.fetch(new Request(`http://localhost${path}`, { headers: { cookie } }));
}

/** Typed against the contract, so a response-shape drift fails to compile. */
async function adminJson<T>(path: string, cookie: string): Promise<T> {
  return (await admin(path, cookie)).json() as Promise<T>;
}

/**
 * Two installs with different histories: A takes the update and confirms it,
 * B is served the update but never reports running it.
 */
async function scenario() {
  await device(deviceHeaders(DEVICE_A));
  await device(deviceHeaders(DEVICE_A, { 'expo-current-update-id': seeded.updateId }));
  await device(deviceHeaders(DEVICE_B, { 'x-ota-user-id': 'user_b' }));
}

describe('device adoption endpoint', () => {
  test('reports running, served and confirmed counts per update', async () => {
    const cookie = await login();
    await scenario();

    const response = await admin(
      `/api/admin/applications/${seeded.applicationId}/device-adoption`,
      cookie,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as DeviceAdoption;
    expect(body.trackingEnabled).toBe(true);
    expect(body.totals.installs).toBe(2);
    expect(body.totals.activeLast24h).toBe(2);

    const row = body.byUpdate.find((r) => r.updateId === seeded.updateId);
    expect(row!.releaseNumber).toBe(1);
    expect(row!.served).toBe(2);
    // Only A came back and said it was running the update.
    expect(row!.confirmed).toBe(1);
    expect(row!.running).toBe(1);
  });

  test('falls back to the reported runtime version for an embedded (unpublished) update', async () => {
    const cookie = await login();
    await device(
      deviceHeaders(DEVICE_C, {
        'expo-current-update-id': EMBEDDED_UPDATE_ID,
        'expo-runtime-version': '2.0.0',
      }),
    );

    const response = await admin(
      `/api/admin/applications/${seeded.applicationId}/device-adoption`,
      cookie,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as DeviceAdoption;
    const row = body.byUpdate.find((r) => r.updateId === EMBEDDED_UPDATE_ID);
    expect(row).toBeDefined();
    expect(row!.releaseNumber).toBe(null);
    expect(row!.runtimeVersion).toBe('2.0.0');
    expect(row!.running).toBe(1);
  });

  test('reports trackingEnabled false when the feature is off', async () => {
    app = createTestApp(db, storage, { DEVICE_TRACKING_ENABLED: 'false' }).app;
    const cookie = await login();

    const response = await admin(
      `/api/admin/applications/${seeded.applicationId}/device-adoption`,
      cookie,
    );
    expect(((await response.json()) as DeviceAdoption).trackingEnabled).toBe(false);
  });

  test('requires a session', async () => {
    const response = await app.fetch(
      new Request(
        `http://localhost/api/admin/applications/${seeded.applicationId}/device-adoption`,
      ),
    );
    expect(response.status).toBe(401);
  });
});

describe('device list endpoint', () => {
  test('returns one row per install, newest first', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices`,
      cookie,
    );

    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.clientId).toBe(DEVICE_B);
    expect(body.items[0]!.userId).toBe('user_b');
    expect(body.items[0]!.clientIdSource).toBe('eas');
  });

  test('filters by updateId', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?updateId=${seeded.updateId}`,
      cookie,
    );

    expect(body.total).toBe(1);
    expect(body.items[0]!.clientId).toBe(DEVICE_A);
    expect(body.items[0]!.currentReleaseNumber).toBe(1);
  });

  test('filters by userId and platform', async () => {
    const cookie = await login();
    await scenario();

    const byUser = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?userId=user_b`,
      cookie,
    );
    expect(byUser.total).toBe(1);
    expect(byUser.items[0]!.clientId).toBe(DEVICE_B);

    const byPlatform = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?platform=ios`,
      cookie,
    );
    expect(byPlatform.total).toBe(0);
  });

  test('returns and filters by device facts', async () => {
    const cookie = await login();
    await device(
      deviceHeaders(DEVICE_A, {
        'expo-extra-params': 'os-version="17.5.1", device-brand="Apple", device-model="iPhone15,2"',
      }),
    );
    await device(
      deviceHeaders(DEVICE_B, { 'expo-extra-params': 'os-version="14", device-brand="google"' }),
    );

    const all = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices`,
      cookie,
    );
    const a = all.items.find((i) => i.clientId === DEVICE_A);
    expect(a!.osVersion).toBe('17.5.1');
    expect(a!.deviceBrand).toBe('Apple');
    expect(a!.deviceModel).toBe('iPhone15,2');
    const b = all.items.find((i) => i.clientId === DEVICE_B);
    expect(b!.deviceModel).toBeNull();

    const google = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?deviceBrand=google`,
      cookie,
    );
    expect(google.total).toBe(1);
    expect(google.items[0]!.clientId).toBe(DEVICE_B);

    const ios17 = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?osVersion=17.5.1`,
      cookie,
    );
    expect(ios17.total).toBe(1);
    expect(ios17.items[0]!.clientId).toBe(DEVICE_A);
  });

  test('paginates', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices?limit=1&offset=1`,
      cookie,
    );

    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
  });

  test('rejects an out-of-range limit with a 422', async () => {
    const cookie = await login();
    const response = await admin(
      `/api/admin/applications/${seeded.applicationId}/devices?limit=500`,
      cookie,
    );
    expect(response.status).toBe(422);
  });

  test('requires a session', async () => {
    const response = await app.fetch(
      new Request(`http://localhost/api/admin/applications/${seeded.applicationId}/devices`),
    );
    expect(response.status).toBe(401);
  });
});

describe('update recipients endpoint', () => {
  test('answers who received the update and who confirmed it', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceRecipients>(
      `/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices`,
      cookie,
    );

    expect(body.updateId).toBe(seeded.updateId);
    expect(body.served).toBe(2);
    expect(body.confirmed).toBe(1);
    expect(body.total).toBe(2);

    const a = body.items.find((i) => i.clientId === DEVICE_A);
    expect(a!.confirmedAt).not.toBeNull();
    expect(a!.stillRunning).toBe(true);

    const b = body.items.find((i) => i.clientId === DEVICE_B);
    expect(b!.servedAt).not.toBeNull();
    expect(b!.confirmedAt).toBeNull();
    expect(b!.stillRunning).toBe(false);
    expect(b!.userId).toBe('user_b');
  });

  test('carries the device facts of each recipient', async () => {
    const cookie = await login();
    // Facts sent once, before the scenario's requests, which omit them: the
    // recipients view has to see the sticky values, not the latest poll's nulls.
    await device(
      deviceHeaders(DEVICE_A, { 'expo-extra-params': 'device-brand="Apple", os-version="17.5.1"' }),
    );
    await scenario();

    const body = await adminJson<DeviceRecipients>(
      `/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices`,
      cookie,
    );
    const a = body.items.find((i) => i.clientId === DEVICE_A);
    expect(a!.deviceBrand).toBe('Apple');
    expect(a!.osVersion).toBe('17.5.1');
    expect(a!.deviceModel).toBeNull();
  });

  test('kind=confirmed narrows to installs that actually launched it', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceRecipients>(
      `/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices?kind=confirmed`,
      cookie,
    );

    expect(body.total).toBe(1);
    expect(body.items[0]!.clientId).toBe(DEVICE_A);
  });

  test('an install that has moved on is reported as no longer running', async () => {
    const cookie = await login();
    await scenario();
    // A reboots onto something else entirely.
    await device(
      deviceHeaders(DEVICE_A, { 'expo-current-update-id': '00000000-0000-4000-8000-00000000beef' }),
    );

    const body = await adminJson<DeviceRecipients>(
      `/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices`,
      cookie,
    );

    const a = body.items.find((i) => i.clientId === DEVICE_A);
    // It still received and confirmed the update — history is not rewritten.
    expect(a!.confirmedAt).not.toBeNull();
    expect(a!.stillRunning).toBe(false);
  });

  test('an unknown update id returns empty rather than 404', async () => {
    const cookie = await login();
    await scenario();

    const body = await adminJson<DeviceRecipients>(
      `/api/admin/applications/${seeded.applicationId}/updates/00000000-0000-4000-8000-000000000000/devices`,
      cookie,
    );

    expect(body.total).toBe(0);
    expect(body.served).toBe(0);
  });

  test('requires a session', async () => {
    const response = await app.fetch(
      new Request(
        `http://localhost/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices`,
      ),
    );
    expect(response.status).toBe(401);
  });
});

describe('application scoping', () => {
  test('one application never sees another application’s installs', async () => {
    const cookie = await login();
    const other = await seedApplication(db, storage, { slug: 'other', updateKey: 'ota_other' });

    await device(deviceHeaders(DEVICE_A));
    await app.fetch(
      new Request('http://localhost/api/v1/updates/ota_other', {
        headers: clientHeaders({ 'eas-client-id': DEVICE_A }),
      }),
    );

    const first = await adminJson<DeviceList>(
      `/api/admin/applications/${seeded.applicationId}/devices`,
      cookie,
    );
    const second = await adminJson<DeviceList>(
      `/api/admin/applications/${other.applicationId}/devices`,
      cookie,
    );

    // Same physical install, two rows, each visible only under its own app.
    expect(first.total).toBe(1);
    expect(second.total).toBe(1);
  });
});

describe('active device metrics', () => {
  test('validates filters and returns the typed metrics response', async () => {
    const cookie = await login();
    await scenario();
    const path = `/api/admin/applications/${seeded.applicationId}/device-metrics`;
    expect((await admin(path, '')).status).toBe(401);
    for (const query of [
      'activeWithinDays=2',
      'activeWithinDays=0',
      'activeWithinDays=Infinity',
      'platform=windows',
    ]) {
      expect((await admin(`${path}?${query}`, cookie)).status).toBe(422);
    }
    const response = await admin(path, cookie);
    expect(response.status).toBe(200);
    const body = deviceMetricsSchema.parse(await response.json());
    expect(body.groups[0]).toMatchObject({
      activeEligible: 2,
      activeOnTarget: 1,
      adoptionPercent: 50,
    });
    expect(body.activeWithinDays).toBe(7);
    expect(body.retentionDays).toBe(90);
    app = createTestApp(db, storage, { DEVICE_TRACKING_ENABLED: 'false' }).app;
    expect(
      deviceMetricsSchema.parse(await (await admin(path, cookie)).json()).trackingEnabled,
    ).toBe(false);
  });
});

test('recipient pages have stable ties and retain events after install pruning', async () => {
  const cookie = await login();
  await scenario();
  await device(deviceHeaders(DEVICE_C));
  const timestamp = new Date('2026-01-01');
  await db.update(deviceUpdateEvents).set({ createdAt: timestamp });
  await db.delete(deviceInstalls).where(eq(deviceInstalls.clientId, DEVICE_A));
  const other = await seedApplication(db, storage, { slug: 'other-page', updateKey: 'other-page' });
  await db.insert(deviceUpdateEvents).values({
    applicationId: other.applicationId,
    clientId: DEVICE_A,
    updateId: seeded.updateId,
    kind: 'served',
    platform: 'android',
    createdAt: timestamp,
  });
  const path = `/api/admin/applications/${seeded.applicationId}/updates/${seeded.updateId}/devices`;
  const pages: DeviceRecipients[] = [];
  for (let offset = 0; offset < 4; offset++) {
    pages.push(await adminJson<DeviceRecipients>(`${path}?limit=1&offset=${offset}`, cookie));
  }
  expect(pages.map((p) => p.items[0]?.clientId)).toEqual([DEVICE_A, DEVICE_B, DEVICE_C, undefined]);
  expect(pages[0]).toMatchObject({ served: 3, confirmed: 1, total: 3 });
  expect(pages[0]?.items[0]).toMatchObject({ lastSeenAt: null, clientIdSource: null });
  expect(pages[1]?.items[0]?.lastSeenAt).not.toBeNull();
  const confirmed = await adminJson<DeviceRecipients>(`${path}?kind=confirmed&limit=1`, cookie);
  expect(confirmed).toMatchObject({ served: 3, confirmed: 1, total: 1 });
  expect(confirmed.items[0]?.clientId).toBe(DEVICE_A);
});
