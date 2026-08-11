import { beforeEach, describe, expect, test } from 'bun:test';
import type { OtaDatabase } from '@ota/db';
import { createAdmin } from '../src/services/auth.ts';
import { createMigratedDb, createTestApp, MemoryStorage, seedApplication } from './helpers.ts';

let db: OtaDatabase;
let app: ReturnType<typeof createTestApp>['app'];
let storage: MemoryStorage;

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  app = createTestApp(db, storage).app;
  await createAdmin(db, { email: EMAIL, password: PASSWORD, name: 'Admin' });
});

async function login(): Promise<string> {
  const response = await app.fetch(
    new Request('http://localhost/api/admin/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  const cookie = response.headers.get('set-cookie');
  return cookie!.split(';')[0]!;
}

// Regression coverage for GitHub issue #2, Issue 3: passing the application's
// update key (the "ota_…" value from the updates URL) into an admin route that
// expects the UUID id must name the correct id instead of a dead-end 404.
describe('loadApplication update-key mistake', () => {
  test('an update key in the id slot names the correct UUID', async () => {
    const cookie = await login();
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_realkey123',
    });

    const response = await app.fetch(
      new Request('http://localhost/api/admin/applications/ota_realkey123', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toContain('update key');
    expect(body.message).toContain(seeded.applicationId);
  });

  test('a garbage id still returns the plain "Unknown application." message', async () => {
    const cookie = await login();

    const response = await app.fetch(
      new Request('http://localhost/api/admin/applications/not-a-real-id', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toBe('Unknown application.');
  });

  test('the improved error also reaches nested admin routes, since they all resolve through loadApplication', async () => {
    const cookie = await login();
    const seeded = await seedApplication(db, storage, {
      slug: 'lekho',
      updateKey: 'ota_anotherkey456',
    });

    const response = await app.fetch(
      new Request('http://localhost/api/admin/applications/ota_anotherkey456/channels', {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.message).toContain(seeded.applicationId);
  });
});
