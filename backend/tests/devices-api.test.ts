import { beforeEach, describe, expect, test } from 'bun:test';
import type { DeviceAdoption, DeviceList, DeviceRecipients } from '@ota/contracts';
import type { OtaDatabase } from '@ota/db';
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
