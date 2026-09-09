import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { loadEnv } from '../src/config/env.ts';
import type { Logger } from '../src/lib/logger.ts';
import { TrackingDiagnostics } from '../src/lib/tracking-diagnostics.ts';
import { createMigratedDb, deviceHeaders, MemoryStorage, seedApplication } from './helpers.ts';

function captureLogger() {
  const warnings: unknown[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    error() {},
    warn(event, fields) {
      warnings.push({ event, ...fields });
    },
    child() {
      return logger;
    },
  };
  return { logger, warnings };
}

test('warns immediately and reports suppressed failures per category at the next window', () => {
  const { logger, warnings } = captureLogger();
  const reporter = new TrackingDiagnostics(logger);
  reporter.failure('device', 'app-a', 0);
  reporter.failure('device', 'app-b', 10);
  reporter.failure('device', 'app-b', 59_999);
  reporter.failure('usage', 'app-a', 10);
  reporter.failure('device', 'app-b', 60_000);
  expect(warnings).toEqual([
    {
      event: 'tracking_write_failed',
      category: 'device',
      applicationId: 'app-a',
      suppressedFailures: 0,
    },
    {
      event: 'tracking_write_failed',
      category: 'usage',
      applicationId: 'app-a',
      suppressedFailures: 0,
    },
    {
      event: 'tracking_write_failed',
      category: 'device',
      applicationId: 'app-b',
      suppressedFailures: 2,
    },
  ]);
});

test('a broken logging sink cannot propagate into delivery', () => {
  const { logger } = captureLogger();
  logger.warn = () => {
    throw new Error('sink unavailable');
  };
  expect(() => new TrackingDiagnostics(logger).failure('usage', 'app')).not.toThrow();
});

for (const table of ['usage_daily', 'device_installs', 'device_update_events']) {
  test(`delivery survives missing ${table} and emits a sanitized warning`, async () => {
    const db = createMigratedDb();
    const storage = new MemoryStorage();
    const seeded = await seedApplication(db, storage, {
      slug: 'warning',
      updateKey: 'warning',
      signed: false,
    });
    const { logger, warnings } = captureLogger();
    const app = createApp({
      db,
      storage,
      logger,
      env: loadEnv({ DATABASE_URL: ':memory:', OTA_PUBLIC_URL: 'http://localhost' }),
    });
    await db.run(sql.raw(`DROP TABLE ${table}`));
    for (let n = 0; n < 2; n++) {
      const headers = deviceHeaders('aaaaaaaa-1111-4000-8000-000000000001', {
        'expo-expect-signature': null,
      });
      const response = await app.fetch(
        new Request('http://localhost/api/v1/updates/warning', { headers }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(seeded.manifestJson);
    }
    expect(warnings).toEqual([
      {
        event: 'tracking_write_failed',
        category: table === 'usage_daily' ? 'usage' : 'device',
        applicationId: seeded.applicationId,
        suppressedFailures: 0,
      },
    ]);
  });
}
