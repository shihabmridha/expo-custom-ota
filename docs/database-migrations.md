# Database and migrations

SQLite through Drizzle ORM via Bun's native `bun:sqlite` driver, with Drizzle Kit generating
migrations. Same local file, same schema, same generated SQL in development and production.

## Workflow

```bash
bun run db:generate   # diff the schema, write a migration
bun run db:migrate    # apply pending migrations
bun run db:studio     # browse
```

Run these from the repository root. Migrations are committed, and production applies them on
container start — the runtime image does not include Drizzle Kit.

## One driver

`createDb` always goes through `drizzle-orm/bun-sqlite` over Bun's built-in `bun:sqlite`. There
is no URL-scheme branching and no alternate driver — `DATABASE_URL` is a `file:` path (or
`:memory:` for tests), resolved to an absolute path and opened directly. This is a zero-dependency
choice: no native N-API bindings to build, no network round trip, no separate database service to
run or operate.

## Conventions

| Concern | Choice | Why |
|---|---|---|
| Primary keys | `text` UUID, generated app-side | Externally visible resources should not be enumerable |
| Timestamps | `integer` epoch-ms | Sortable, timezone-free, index-friendly. ISO strings appear only inside baked manifests |
| Booleans | `integer` with `mode: 'boolean'` | SQLite has no boolean type |
| Statuses | `text` + TS union + CHECK | Portable; no Postgres enums |
| JSON | `text` with `mode: 'json'` | Except manifests — see below |

Never: Postgres enums, array columns, `SERIAL`, JSONB operators, advisory locks.

### `release_variants.manifest` is plain text

It holds the exact serialized manifest string that was signed. Drizzle's `{ mode: 'json' }`
would parse on read and re-serialize on write, changing the bytes and silently invalidating
every client signature — the protocol has no canonicalization step. There is a comment on the
column saying so, because it looks like an oversight otherwise.

## Constraints that carry weight

| Constraint | Protects |
|---|---|
| `UNIQUE(deployments: application_id, channel_id, platform, runtime_version)` | One serving mapping per target; makes concurrent publishes deterministic via upsert |
| `UNIQUE(applications.slug)`, `UNIQUE(applications.update_key)` | Identity |
| `UNIQUE(channels: application_id, name)` | Per-application channels; the same name across apps is fine |
| `UNIQUE(releases: application_id, release_number)` | Application-local numbering |
| `UNIQUE(release_variants.update_id)` | Update ids are globally unique |
| `UNIQUE(release_variants: release_id, platform)` | At most one variant per platform |
| `UNIQUE(assets.sha256)` | Content addressing and deduplication |
| Partial `UNIQUE(signing_keys.application_id) WHERE status='active'` | Exactly one active key per app, enforced by the database rather than a racy service check |
| `CHECK((release_variant_id IS NOT NULL) <> (directive IS NOT NULL))` | A deployment serves either an update or a directive, never both or neither |

`packages/db/tests/constraints.test.ts` asserts each of these against the generated SQL,
including that foreign keys actually fire — `bun:sqlite` leaves `PRAGMA foreign_keys` **off** by
default, so the client turns it on for every connection. Without that, every foreign key in the
schema would be decorative and the isolation tests would pass without proving anything.

## Transactions

Deployment changes use `INSERT … ON CONFLICT DO UPDATE` rather than read-modify-write, so
concurrency is handled by the unique constraint rather than by lock ordering. Release numbers
are allocated with a single `INSERT … SELECT COALESCE(MAX(...),0)+1`.

This makes the concurrent-publish behaviour a property of the schema rather than of the service
code — no wrapping transaction is needed for correctness. See D3 in `docs/decisions.md`: there is
no `db.batch()` or interactive transaction anywhere in the codebase; each multi-statement
operation runs as sequential awaited statements against `bun:sqlite`, and it is the upsert, not
atomicity, that makes concurrent publishes deterministic.

## Adding a table

1. Add the schema file under `packages/db/src/schema/` and export it from `index.ts`.
2. `bun run db:generate`, then read the generated SQL — check constraints and partial indexes
   are easy to get wrong.
3. Add constraint tests.
4. `bun run db:migrate`.
