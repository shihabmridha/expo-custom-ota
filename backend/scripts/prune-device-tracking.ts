import { createDb } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { lt, sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.ts';

/**
 * Prune per-install tracking rows past their retention window.
 *
 * Growth is already bounded by the unique index on `device_update_events` — an
 * install polling forever adds nothing after its first row per update — so this
 * exists to age out installs that are simply gone, not to contain runaway
 * writes. See D16 in `docs/decisions.md`.
 *
 * Note the install delete is a table scan: `device_installs_app_seen_idx` leads
 * with `application_id`, so a cutoff-only predicate cannot use it. That is fine
 * for a maintenance script run from cron, and deliberately not worth a
 * fourth index on a table written on every device request.
 *
 *   bun run prune:devices                 # dry run, uses DEVICE_TRACKING_RETENTION_DAYS
 *   bun run prune:devices -- --days 30
 *   bun run prune:devices -- --apply
 */
const apply = process.argv.includes('--apply');
const daysArg = process.argv.indexOf('--days');

const env = loadEnv();
const days = Number(
  daysArg === -1 ? env.DEVICE_TRACKING_RETENTION_DAYS : process.argv[daysArg + 1],
);

if (!Number.isFinite(days) || days < 0) {
  console.error(
    `Invalid retention: ${days}. Pass --days <n>, or set DEVICE_TRACKING_RETENTION_DAYS.`,
  );
  process.exit(1);
}

if (days === 0) {
  console.log('Retention is 0 — rows are kept forever. Nothing to prune.');
  process.exit(0);
}

const db = createDb({ url: env.DATABASE_URL });
const cutoff = new Date(Date.now() - days * 86_400_000);

const [eventRow] = await db
  .select({ n: sql<number>`count(*)` })
  .from(schema.deviceUpdateEvents)
  .where(lt(schema.deviceUpdateEvents.createdAt, cutoff));

const [installRow] = await db
  .select({ n: sql<number>`count(*)` })
  .from(schema.deviceInstalls)
  .where(lt(schema.deviceInstalls.lastSeenAt, cutoff));

const events = Number(eventRow?.n ?? 0);
const installs = Number(installRow?.n ?? 0);

console.log(
  `${events} event(s) older than ${days} day(s), ` +
    `${installs} install(s) not seen in ${days} day(s).`,
);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to delete.');
  process.exit(0);
}

// Events first, installs second. An install row with no events is a correct
// state — a device that only ever polled — whereas events for a deleted install
// still answer "who received update X". Deleting installs first would leave the
// more valuable half orphaned if the run were interrupted.
await db.delete(schema.deviceUpdateEvents).where(lt(schema.deviceUpdateEvents.createdAt, cutoff));
await db.delete(schema.deviceInstalls).where(lt(schema.deviceInstalls.lastSeenAt, cutoff));

console.log(`\nRemoved ${events} event(s) and ${installs} install(s).`);
