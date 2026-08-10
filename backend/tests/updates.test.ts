import { beforeEach, describe, expect, test } from 'bun:test';
import type { OtaDatabase } from '@ota/db';
import { extractPartBody, parseBoundary, verifySignature } from '@ota/protocol';
import {
  clientHeaders,
  createMigratedDb,
  createTestApp,
  MemoryStorage,
  seedApplication,
  TEST_CERT_PEM,
} from './helpers.ts';

let db: OtaDatabase;
let storage: MemoryStorage;
let app: ReturnType<typeof createTestApp>['app'];

beforeEach(() => {
  db = createMigratedDb();
  storage = new MemoryStorage();
  app = createTestApp(db, storage).app;
});

function get(updateKey: string, headers = clientHeaders()) {
  return app.fetch(new Request(`http://localhost/api/v1/updates/${updateKey}`, { headers }));
}

async function manifestFrom(response: Response) {
  const boundary = parseBoundary(response.headers.get('content-type') ?? '');
  expect(boundary).not.toBe(null);
  const body = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(body);
  return {
    text,
    manifest: extractPartBody(body, boundary!, 'manifest'),
    directive: extractPartBody(body, boundary!, 'directive'),
    signature: /expo-signature: sig="([^"]+)"/.exec(text)?.[1] ?? null,
  };
}

describe('GET /api/v1/updates/:updateKey', () => {
  test('serves a signed update to a real client request', async () => {
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });

    const response = await get(
      'ota_acadion',
      clientHeaders({
        'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('expo-protocol-version')).toBe('1');
    expect(response.headers.get('expo-sfv-version')).toBe('0');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0');
    expect(response.headers.get('content-type')).toStartWith('multipart/mixed; boundary=');

    const { manifest, signature } = await manifestFrom(response);

    // Byte-for-byte what was stored — not a re-serialization.
    expect(manifest).toBe(seeded.manifestJson);
    expect(JSON.parse(manifest!).id).toBe(seeded.updateId);

    // And the signature still verifies after the round trip through multipart.
    expect(signature).not.toBe(null);
    expect(await verifySignature(manifest!, signature!, TEST_CERT_PEM)).toBe(true);
  });

  test('serves an unsigned update when the client does not ask for a signature', async () => {
    await seedApplication(db, storage, { slug: 'acadion', updateKey: 'ota_acadion' });
    const { text } = await manifestFrom(await get('ota_acadion'));
    expect(text).not.toContain('expo-signature');
  });

  test('returns 200 with noUpdateAvailable when the device already has the update', async () => {
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });

    const response = await get(
      'ota_acadion',
      clientHeaders({ 'expo-current-update-id': seeded.updateId.toUpperCase() }),
    );

    expect(response.status).toBe(200);
    const { directive, manifest } = await manifestFrom(response);
    expect(manifest).toBe(null);
    expect(JSON.parse(directive!)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('returns 200 with noUpdateAvailable when no deployment exists', async () => {
    await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
      runtimeVersion: '1.0.0',
    });

    // A device on a runtime version nothing is deployed for.
    const response = await get('ota_acadion', clientHeaders({ 'expo-runtime-version': '9.9.9' }));

    expect(response.status).toBe(200);
    const { directive } = await manifestFrom(response);
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });

  test('signs directives when the client requested a signature', async () => {
    // Omitting this makes the client throw "No expo-signature header specified".
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });

    const response = await get(
      'ota_acadion',
      clientHeaders({
        'expo-current-update-id': seeded.updateId,
        'expo-expect-signature': 'sig, keyid="main"',
      }),
    );

    const { directive, signature } = await manifestFrom(response);
    expect(signature).not.toBe(null);
    expect(await verifySignature(directive!, signature!, TEST_CERT_PEM)).toBe(true);
  });

  test('never serves an update for a different runtime version', async () => {
    await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
      runtimeVersion: '1.5.0',
    });

    const { directive } = await manifestFrom(
      await get('ota_acadion', clientHeaders({ 'expo-runtime-version': '1.4.0' })),
    );
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });

  test('never serves an update for a different platform', async () => {
    await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
      platform: 'android',
    });

    const { directive } = await manifestFrom(
      await get('ota_acadion', clientHeaders({ 'expo-platform': 'ios' })),
    );
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });

  test('falls back to the application default channel', async () => {
    await seedApplication(db, storage, { slug: 'acadion', updateKey: 'ota_acadion' });
    const { manifest } = await manifestFrom(
      await get('ota_acadion', clientHeaders({ 'expo-channel-name': null })),
    );
    expect(manifest).not.toBe(null);
  });

  test('returns noUpdateAvailable for an unknown channel', async () => {
    await seedApplication(db, storage, { slug: 'acadion', updateKey: 'ota_acadion' });
    const { directive } = await manifestFrom(
      await get('ota_acadion', clientHeaders({ 'expo-channel-name': 'nonexistent' })),
    );
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });

  test('404s on an unknown update key', async () => {
    const response = await get('ota_nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'UNKNOWN_UPDATE_KEY' });
  });

  test.each([
    ['bad platform', { 'expo-platform': 'windows' }, 400],
    ['missing runtime version', { 'expo-runtime-version': null }, 400],
    ['unsupported protocol', { 'expo-protocol-version': '2' }, 400],
    ['unacceptable content type', { accept: 'text/html' }, 406],
  ])('rejects %s with %p', async (_label, overrides, status) => {
    await seedApplication(db, storage, { slug: 'acadion', updateKey: 'ota_acadion' });
    const response = await get('ota_acadion', clientHeaders(overrides as Record<string, string>));
    expect(response.status).toBe(status);
  });

  test('rejects a non-GET request with 405', async () => {
    await seedApplication(db, storage, { slug: 'acadion', updateKey: 'ota_acadion' });
    const response = await app.fetch(
      new Request('http://localhost/api/v1/updates/ota_acadion', {
        method: 'POST',
        headers: clientHeaders(),
      }),
    );
    expect(response.status).toBe(405);
  });

  test('errors when a signature is requested but no signing key exists', async () => {
    await seedApplication(db, storage, {
      slug: 'unsigned',
      updateKey: 'ota_unsigned',
      signed: false,
    });

    const response = await get(
      'ota_unsigned',
      clientHeaders({ 'expo-expect-signature': 'sig, keyid="main"' }),
    );

    // Better a loud 500 than silently serving unsigned bytes to a client that
    // will reject them with an opaque error.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'SIGNING_UNAVAILABLE' });
  });
});

/**
 * The isolation invariant from the spec: two applications with identical
 * channel, platform and runtime version must never receive each other's
 * releases.
 */
describe('multi-application isolation', () => {
  test('each application receives only its own release', async () => {
    const a = await seedApplication(db, storage, {
      slug: 'appa',
      updateKey: 'ota_a',
      bundleContent: '// A1',
    });
    const b = await seedApplication(db, storage, {
      slug: 'appb',
      updateKey: 'ota_b',
      bundleContent: '// B1',
    });

    expect(a.updateId).not.toBe(b.updateId);

    const fromA = await manifestFrom(await get('ota_a'));
    const fromB = await manifestFrom(await get('ota_b'));

    expect(JSON.parse(fromA.manifest!).id).toBe(a.updateId);
    expect(JSON.parse(fromB.manifest!).id).toBe(b.updateId);

    // Explicitly: neither ever sees the other's update.
    expect(JSON.parse(fromA.manifest!).id).not.toBe(b.updateId);
    expect(JSON.parse(fromB.manifest!).id).not.toBe(a.updateId);
  });

  test('each application signs with its own certificate', async () => {
    await seedApplication(db, storage, { slug: 'appa', updateKey: 'ota_a' });
    await seedApplication(db, storage, { slug: 'appb', updateKey: 'ota_b' });

    const signed = clientHeaders({ 'expo-expect-signature': 'sig, keyid="main"' });
    for (const key of ['ota_a', 'ota_b']) {
      const { manifest, signature } = await manifestFrom(await get(key, signed));
      expect(await verifySignature(manifest!, signature!, TEST_CERT_PEM)).toBe(true);
    }
  });
});

describe('rollBackToEmbedded', () => {
  async function deployRollback(applicationId: string, channelId: string) {
    const { deployments } = await import('@ota/db');
    const { and, eq } = await import('drizzle-orm');
    await db
      .update(deployments)
      .set({
        releaseVariantId: null,
        directive: 'rollBackToEmbedded',
        directiveCommitTime: new Date('2026-08-10T12:00:00.000Z'),
      })
      .where(
        and(eq(deployments.applicationId, applicationId), eq(deployments.channelId, channelId)),
      );
  }

  test('serves the directive when the client reports an embedded update', async () => {
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });
    await deployRollback(seeded.applicationId, seeded.channelId);

    const { directive } = await manifestFrom(
      await get(
        'ota_acadion',
        clientHeaders({ 'expo-embedded-update-id': '11111111-1111-4111-8111-111111111111' }),
      ),
    );

    expect(JSON.parse(directive!)).toEqual({
      type: 'rollBackToEmbedded',
      parameters: { commitTime: '2026-08-10T12:00:00.000Z' },
    });
  });

  test('degrades to noUpdateAvailable without an embedded update id', async () => {
    // The client cannot act on a rollback if it does not know its embedded id.
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });
    await deployRollback(seeded.applicationId, seeded.channelId);

    const { directive } = await manifestFrom(await get('ota_acadion'));
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });

  test('degrades to noUpdateAvailable when already on the embedded update', async () => {
    const seeded = await seedApplication(db, storage, {
      slug: 'acadion',
      updateKey: 'ota_acadion',
    });
    await deployRollback(seeded.applicationId, seeded.channelId);

    const embedded = '11111111-1111-4111-8111-111111111111';
    const { directive } = await manifestFrom(
      await get(
        'ota_acadion',
        clientHeaders({
          'expo-embedded-update-id': embedded,
          'expo-current-update-id': embedded,
        }),
      ),
    );
    expect(JSON.parse(directive!).type).toBe('noUpdateAvailable');
  });
});
