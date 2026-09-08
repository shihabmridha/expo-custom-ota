import { beforeEach, describe, expect, test } from 'bun:test';
import type { OtaDatabase } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { sql } from 'drizzle-orm';
import {
  clientHeaders,
  createMigratedDb,
  createTestApp,
  deviceHeaders,
  MemoryStorage,
  type SeededApplication,
  seedApplication,
} from './helpers.ts';

/**
 * Per-install tracking, driven through real HTTP requests rather than by
 * calling the service directly — the placement of the tracking calls inside
 * `updates.ts` is part of what is under test.
 */

const OTHER_CLIENT = '99999999-8888-7777-6666-555555555555';

let db: OtaDatabase;
let storage: MemoryStorage;
let app: ReturnType<typeof createTestApp>['app'];
let seeded: SeededApplication;

async function get(headers: Headers, updateKey = 'ota_track') {
  return app.fetch(new Request(`http://localhost/api/v1/updates/${updateKey}`, { headers }));
}

async function installs() {
  return db.select().from(schema.deviceInstalls);
}

async function events() {
  return db.select().from(schema.deviceUpdateEvents);
}

beforeEach(async () => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  ({ app } = createTestApp(db, storage));
  seeded = await seedApplication(db, storage, { slug: 'track', updateKey: 'ota_track' });
});

describe('device install state', () => {
  test('a first request creates exactly one row, first seen == last seen', async () => {
    await get(clientHeaders());

    const rows = await installs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe('11111111-2222-3333-4444-555555555555');
    expect(rows[0]?.clientIdSource).toBe('eas');
    expect(rows[0]?.platform).toBe('android');
    expect(rows[0]?.channelName).toBe('production');
    expect(rows[0]?.requestCount).toBe(1);
    expect(rows[0]?.firstSeenAt.getTime()).toBe(rows[0]?.lastSeenAt.getTime() ?? -1);
  });

  test('a second request updates the row instead of inserting another', async () => {
    await get(clientHeaders());
    await get(clientHeaders());

    const rows = await installs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestCount).toBe(2);
  });

  test('first_seen_at survives later requests', async () => {
    await get(clientHeaders());
    const original = (await installs())[0]?.firstSeenAt.getTime();

    await get(clientHeaders());
    expect((await installs())[0]?.firstSeenAt.getTime()).toBe(original ?? -1);
  });

  test('two client ids under one application are two rows', async () => {
    await get(clientHeaders());
    await get(deviceHeaders(OTHER_CLIENT));

    expect(await installs()).toHaveLength(2);
  });

  test('one client id across two applications is two rows', async () => {
    await seedApplication(db, storage, { slug: 'second', updateKey: 'ota_second' });
    await get(clientHeaders());
    await get(clientHeaders(), 'ota_second');

    const rows = await installs();
    expect(rows).toHaveLength(2);
    // Same physical install, two applications: the isolation invariant.
    expect(new Set(rows.map((r) => r.clientId)).size).toBe(1);
    expect(new Set(rows.map((r) => r.applicationId)).size).toBe(2);
  });

  test('current_update_since moves only when current_update_id actually changes', async () => {
    await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    const first = (await installs())[0]?.currentUpdateSince?.getTime();
    expect(first).toBeGreaterThan(0);

    await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    expect((await installs())[0]?.currentUpdateSince?.getTime()).toBe(first ?? -1);

    await get(clientHeaders({ 'expo-current-update-id': '00000000-0000-4000-8000-000000000000' }));
    expect((await installs())[0]?.currentUpdateSince?.getTime()).not.toBe(first ?? -1);
  });

  test('a later request without a user id keeps the one already captured', async () => {
    await get(clientHeaders({ 'x-ota-user-id': 'user_42' }));
    expect((await installs())[0]?.userId).toBe('user_42');

    await get(clientHeaders());
    expect((await installs())[0]?.userId).toBe('user_42');
  });

  test('a different user id on the same install replaces the stored one', async () => {
    // Log out, someone else logs in: the install row is keyed by eas-client-id,
    // so it is the same row and the sticky coalesce takes the new non-null value.
    await get(clientHeaders({ 'x-ota-user-id': 'user_42' }));
    await get(clientHeaders({ 'x-ota-user-id': 'user_43' }));

    const rows = await installs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe('user_43');
  });

  test('last_served_update_id is set on serve and preserved across later polls', async () => {
    await get(clientHeaders());
    expect((await installs())[0]?.lastServedUpdateId).toBe(seeded.updateId);

    // A poll that yields noUpdateAvailable must not erase what we know.
    await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    expect((await installs())[0]?.lastServedUpdateId).toBe(seeded.updateId);
  });
});

describe('identity resolution', () => {
  test('falls back to the install-id extra param when eas-client-id is absent', async () => {
    await get(
      clientHeaders({ 'eas-client-id': null, 'expo-extra-params': 'install-id="fallback-1"' }),
    );

    const rows = await installs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe('fallback-1');
    expect(rows[0]?.clientIdSource).toBe('extra');
  });

  test('accepts the closed-up installid spelling too', async () => {
    await get(
      clientHeaders({ 'eas-client-id': null, 'expo-extra-params': 'installid="fallback-2"' }),
    );
    expect((await installs())[0]?.clientId).toBe('fallback-2');
  });

  test('a camelCase installId param is not a valid SFV key and yields nothing', async () => {
    // RFC 8941 restricts dictionary keys to lowercase, so the client's own
    // serializer drops the pair. Asserted here so nobody documents `installId`
    // as the fallback and ships a feature that silently never fires.
    await get(
      clientHeaders({ 'eas-client-id': null, 'expo-extra-params': 'installId="fallback-3"' }),
    );
    expect(await installs()).toHaveLength(0);
  });

  test('falls back to x-ota-user-id when both install ids are absent', async () => {
    await get(clientHeaders({ 'eas-client-id': null, 'x-ota-user-id': 'user_7' }));

    const rows = await installs();
    expect(rows).toHaveLength(1);
    // Prefixed so a user-keyed row can never collide with a real install id.
    expect(rows[0]?.clientId).toBe('user:user_7');
    expect(rows[0]?.clientIdSource).toBe('user');
  });

  test('writes nothing at all when no identifier is present', async () => {
    const response = await get(clientHeaders({ 'eas-client-id': null }));

    expect(response.status).toBe(200);
    expect(await installs()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  test('ignores an over-long eas-client-id rather than truncating it', async () => {
    await get(clientHeaders({ 'eas-client-id': 'a'.repeat(200) }));
    expect(await installs()).toHaveLength(0);
  });
});

describe('the event log is bounded', () => {
  test('serving an update appends exactly one served event', async () => {
    await get(clientHeaders());

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('served');
    expect(rows[0]?.updateId).toBe(seeded.updateId);
  });

  test('re-serving the same update to the same install appends no second event', async () => {
    await get(clientHeaders());
    await get(clientHeaders());
    await get(clientHeaders());

    expect((await events()).filter((e) => e.kind === 'served')).toHaveLength(1);
  });

  test('ten consecutive noUpdate polls append zero events', async () => {
    // The headline property: growth is bounded by installs × updates, not by
    // poll frequency. An app polling on every launch must cost nothing.
    for (let i = 0; i < 10; i++) {
      await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    }

    const rows = await events();
    // Only the one confirmed event, from the first poll's transition.
    expect(rows.filter((e) => e.kind === 'served')).toHaveLength(0);
    expect(rows.filter((e) => e.kind === 'confirmed')).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test('serving a different update appends a second served event', async () => {
    await get(clientHeaders());

    // A second application-scoped update at a different runtime version.
    const other = await seedApplication(db, storage, {
      slug: 'track2',
      updateKey: 'ota_track2',
    });
    await get(clientHeaders(), 'ota_track2');

    const rows = await events();
    expect(rows.filter((e) => e.kind === 'served')).toHaveLength(2);
    expect(new Set(rows.map((e) => e.updateId))).toEqual(
      new Set([seeded.updateId, other.updateId]),
    );
  });
});

describe('install proof', () => {
  test('reporting a served update id appends confirmed exactly once', async () => {
    await get(clientHeaders());
    await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));

    const rows = await events();
    expect(rows.filter((e) => e.kind === 'served')).toHaveLength(1);
    expect(rows.filter((e) => e.kind === 'confirmed')).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  test('polling again while still running it appends nothing further', async () => {
    await get(clientHeaders());
    await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    for (let i = 0; i < 5; i++) {
      await get(clientHeaders({ 'expo-current-update-id': seeded.updateId }));
    }

    expect(await events()).toHaveLength(2);
  });

  test('reporting an update we never served appends no confirmed event', async () => {
    // This is what the `WHERE EXISTS` gate buys: the bundle embedded in the
    // binary carries an update id this server never issued, and it must not
    // register as adoption.
    const embedded = '00000000-0000-4000-8000-0000000000ff';
    await get(clientHeaders({ 'expo-current-update-id': embedded }));

    expect((await events()).filter((e) => e.kind === 'confirmed')).toHaveLength(0);
  });

  test('an unserved current id does not retry the confirmation on every poll', async () => {
    const embedded = '00000000-0000-4000-8000-0000000000ff';
    await get(clientHeaders({ 'expo-current-update-id': embedded }));

    // The gate advances regardless, so the steady state stays at one write.
    const rows = await installs();
    expect(rows[0]?.confirmedUpdateId).toBe(embedded);
  });
});

describe('tracking never breaks delivery', () => {
  test('a served manifest is still correct with device_installs dropped', async () => {
    await db.run(sql`DROP TABLE device_installs`);

    const response = await get(clientHeaders());
    expect(response.status).toBe(200);

    const body = await response.text();
    // Byte-for-byte what was signed at import time, tracking failure or not.
    expect(body).toContain(seeded.manifestJson);
  });

  test('with tracking disabled, delivery works and zero rows are written', async () => {
    ({ app } = createTestApp(db, storage, { DEVICE_TRACKING_ENABLED: 'false' }));

    const response = await get(clientHeaders());
    expect(response.status).toBe(200);
    expect(await installs()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });
});

describe('device facts', () => {
  const facts = 'os-version="14", device-brand="google", device-model="Pixel 8 Pro"';

  test('stores os version, brand and model from extra params', async () => {
    await get(clientHeaders({ 'expo-extra-params': facts }));

    const row = (await installs())[0];
    expect(row?.osVersion).toBe('14');
    expect(row?.deviceBrand).toBe('google');
    expect(row?.deviceModel).toBe('Pixel 8 Pro');
  });

  test('a later request without the params keeps the facts already captured', async () => {
    await get(clientHeaders({ 'expo-extra-params': facts }));
    await get(clientHeaders());

    const row = (await installs())[0];
    expect(row?.osVersion).toBe('14');
    expect(row?.deviceBrand).toBe('google');
    expect(row?.deviceModel).toBe('Pixel 8 Pro');
  });

  test('a changed os version overwrites the stored one', async () => {
    await get(clientHeaders({ 'expo-extra-params': facts }));
    await get(clientHeaders({ 'expo-extra-params': 'os-version="15"' }));

    const row = (await installs())[0];
    expect(row?.osVersion).toBe('15');
    expect(row?.deviceBrand).toBe('google');
  });

  test('an over-long label is stored as null rather than truncated', async () => {
    await get(clientHeaders({ 'expo-extra-params': `device-model="${'m'.repeat(65)}"` }));
    expect((await installs())[0]?.deviceModel).toBeNull();
  });

  test('the user-id extra param is stored alongside an eas-keyed install', async () => {
    await get(clientHeaders({ 'expo-extra-params': 'user-id="usr_extra"' }));

    const row = (await installs())[0];
    expect(row?.clientIdSource).toBe('eas');
    expect(row?.userId).toBe('usr_extra');
  });

  test('the user-id extra param is the identity of last resort, like the header', async () => {
    await get(clientHeaders({ 'eas-client-id': null, 'expo-extra-params': 'user-id="usr_only"' }));

    const row = (await installs())[0];
    expect(row?.clientId).toBe('user:usr_only');
    expect(row?.clientIdSource).toBe('user');
  });
});
