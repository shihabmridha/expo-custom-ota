import { beforeEach, describe, expect, test } from 'bun:test';
import { buildPath, contracts } from '@oat/contracts';
import type { OatDatabase } from '@oat/db';
import * as schema from '@oat/db/schema/index';
import { eq } from 'drizzle-orm';
import { isOriginAllowed } from '../src/middleware/admin.ts';
import { createAdmin } from '../src/services/auth.ts';
import { createMigratedDb, createTestApp, MemoryStorage } from './helpers.ts';

let db: OatDatabase;
let app: ReturnType<typeof createTestApp>['app'];

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  db = createMigratedDb();
  app = createTestApp(db, new MemoryStorage()).app;
  await createAdmin(db, { email: EMAIL, password: PASSWORD, name: 'Admin' });
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function login(): Promise<string> {
  const response = await post('/api/admin/auth/login', { email: EMAIL, password: PASSWORD });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toContain('oat_session=');
  return cookie!.split(';')[0]!;
}

describe('login', () => {
  test('succeeds with correct credentials and sets a hardened cookie', async () => {
    const response = await post('/api/admin/auth/login', { email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ admin: { email: EMAIL } });

    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Not Secure in test/dev, which is what allows plain-HTTP local development.
    expect(cookie).not.toContain('Secure');
  });

  test('stores only a hash of the session token', async () => {
    const cookie = await login();
    const token = cookie.split('=')[1]!;

    const sessions = await db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    // A database dump must not be replayable as a session.
    expect(sessions[0]!.tokenHash).not.toBe(token);
    expect(sessions[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a wrong password', async () => {
    const response = await post('/api/admin/auth/login', { email: EMAIL, password: 'wrong' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  test('gives an unknown email the same response as a wrong password', async () => {
    // Different responses would let an attacker enumerate administrators.
    const unknown = await post('/api/admin/auth/login', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  test('rate limits repeated failures', async () => {
    // argon2id costs ~100 ms per verify, so an unlimited login route is a
    // CPU denial-of-service vector.
    for (let i = 0; i < 5; i++) {
      await post('/api/admin/auth/login', { email: EMAIL, password: 'wrong' });
    }
    const blocked = await post('/api/admin/auth/login', { email: EMAIL, password: 'wrong' });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  test('rejects a malformed body with 422 and field errors', async () => {
    const response = await post('/api/admin/auth/login', { email: 'not-an-email' });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; fieldErrors: Record<string, string[]> };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(body.fieldErrors)).toContain('email');
  });
});

describe('session', () => {
  test('reports the signed-in admin', async () => {
    const cookie = await login();
    const response = await app.fetch(
      new Request('http://localhost/api/admin/auth/session', { headers: { cookie } }),
    );
    expect(await response.json()).toMatchObject({ admin: { email: EMAIL } });
  });

  test('returns 200 with a null admin when signed out', async () => {
    // A 401 here would trip the dashboard's "session expired" handling on a
    // perfectly normal first visit.
    const response = await app.fetch(new Request('http://localhost/api/admin/auth/session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ admin: null });
  });

  test('logout destroys the session server-side', async () => {
    const cookie = await login();
    await app.fetch(
      new Request('http://localhost/api/admin/auth/logout', {
        method: 'POST',
        headers: { cookie },
      }),
    );

    expect(await db.select().from(schema.sessions)).toHaveLength(0);

    const after = await app.fetch(
      new Request('http://localhost/api/admin/applications', { headers: { cookie } }),
    );
    expect(after.status).toBe(401);
  });

  test('an expired session is rejected', async () => {
    const cookie = await login();
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) });

    const response = await app.fetch(
      new Request('http://localhost/api/admin/applications', { headers: { cookie } }),
    );
    expect(response.status).toBe(401);
  });
});

/**
 * Enumerated from the contract registry rather than hand-listed, so a new admin
 * route cannot be added without this check covering it.
 */
describe('every admin route requires authentication', () => {
  const adminRoutes = Object.entries(contracts).flatMap(([group, routes]) =>
    Object.entries(routes)
      .filter(([, route]) => route.auth === 'admin')
      .map(([name, route]) => ({ label: `${group}.${name}`, route })),
  );

  test('the registry actually contains admin routes', () => {
    expect(adminRoutes.length).toBeGreaterThan(10);
  });

  test.each(adminRoutes.map((r) => [r.label, r.route] as const))(
    '%s rejects an unauthenticated request',
    async (_label, route) => {
      const params = Object.fromEntries(
        [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => [m[1]!, 'some-id']),
      );

      const response = await app.fetch(
        new Request(`http://localhost${buildPath(route.path, params)}`, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          ...(route.method === 'GET' || route.method === 'DELETE'
            ? {}
            : { body: JSON.stringify({}) }),
        }),
      );

      expect(response.status).toBe(401);
    },
  );
});

describe('CSRF origin check', () => {
  test('rejects a mutation from a foreign origin', async () => {
    const cookie = await login();
    const response = await post(
      '/api/admin/applications',
      { name: 'x', slug: 'x', androidPackage: 'a.b.c' },
      { cookie, origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
  });

  test('allows a mutation from the configured origin', async () => {
    const cookie = await login();
    const response = await post(
      '/api/admin/applications',
      {
        name: 'Acadion',
        slug: 'acadion',
        androidPackage: 'xyz.acadion.mobile',
        generateSigningKey: false,
      },
      { cookie, origin: 'http://localhost:3000' },
    );
    expect(response.status).toBe(201);
  });

  test('allows a request with no Origin (curl, the SDK)', async () => {
    const cookie = await login();
    const response = await post(
      '/api/admin/applications',
      {
        name: 'Lekho',
        slug: 'lekho',
        androidPackage: 'xyz.lekho.mobile',
        generateSigningKey: false,
      },
      { cookie },
    );
    expect(response.status).toBe(201);
  });
});

describe('application lifecycle over HTTP', () => {
  test('creating an application seeds channels and a signing key', async () => {
    const cookie = await login();
    const response = await post(
      '/api/admin/applications',
      {
        name: 'Acadion Mobile',
        slug: 'acadion-mobile',
        androidPackage: 'xyz.acadion.mobile',
        iosBundleIdentifier: 'xyz.acadion.mobile',
      },
      { cookie },
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; updateKey: string };
    expect(created.updateKey).toStartWith('ota_');

    const channels = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.applicationId, created.id));
    expect(channels.map((c) => c.name).sort()).toEqual(['production', 'staging']);

    const keys = await db
      .select()
      .from(schema.applicationSigningKeys)
      .where(eq(schema.applicationSigningKeys.applicationId, created.id));
    expect(keys[0]?.keyId).toBe('main');
    expect(keys[0]?.certificatePem).toContain('BEGIN CERTIFICATE');
  });

  test('requires at least one native identifier', async () => {
    const cookie = await login();
    const response = await post(
      '/api/admin/applications',
      { name: 'No Identity', slug: 'no-identity' },
      { cookie },
    );
    expect(response.status).toBe(422);
  });

  test('client-config never exposes private key material', async () => {
    const cookie = await login();
    const created = (await (
      await post(
        '/api/admin/applications',
        { name: 'Acadion', slug: 'acadion', androidPackage: 'xyz.acadion.mobile' },
        { cookie },
      )
    ).json()) as { id: string };

    const response = await app.fetch(
      new Request(`http://localhost/api/admin/applications/${created.id}/client-config`, {
        headers: { cookie },
      }),
    );
    const config = (await response.json()) as { appJsonSnippet: string; certificatePem: string };

    expect(config.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(config)).not.toContain('PRIVATE KEY');
    // The snippet uses the header the real client sends.
    expect(config.appJsonSnippet).toContain('expo-channel-name');
    expect(config.appJsonSnippet).toContain('rsa-v1_5-sha256');
  });
});

describe('origin allowlist', () => {
  const production = { allowed: ['https://ota.acadion.xyz'], devLoose: false };
  const development = { allowed: ['http://192.168.0.53:3000'], devLoose: true };

  test('production accepts only the exact origin', () => {
    expect(isOriginAllowed('https://ota.acadion.xyz', production)).toBe(true);
    expect(isOriginAllowed('https://ota.acadion.xyz:8443', production)).toBe(false);
    expect(isOriginAllowed('https://evil.example.com', production)).toBe(false);
    // A hostname that merely contains the allowed one must not pass.
    expect(isOriginAllowed('https://ota.acadion.xyz.evil.com', production)).toBe(false);
  });

  test('development accepts the Vite port on the same LAN host', () => {
    // The dashboard is served from :5173 while the API answers on :3000.
    expect(isOriginAllowed('http://192.168.0.53:5173', development)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', development)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', development)).toBe(true);
  });

  test('development still rejects a different host', () => {
    expect(isOriginAllowed('http://192.168.0.99:5173', development)).toBe(false);
    expect(isOriginAllowed('https://evil.example.com', development)).toBe(false);
  });

  test('rejects a malformed origin', () => {
    expect(isOriginAllowed('not a url', development)).toBe(false);
  });
});
