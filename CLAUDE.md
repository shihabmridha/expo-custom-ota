# expo-custom-ota — agent working notes

Self-hosted, multi-application OTA update server compatible with `expo-updates` and the
**Expo Updates v1 protocol**. Replaces EAS Update. Admin uploads an `expo export` archive
through a dashboard; the server validates, stores assets content-addressably, signs a
manifest, and serves it to devices.

**Read `docs/protocol-notes.md` before touching anything protocol-related.** It is researched
ground truth, not guesswork. Do not re-derive it, and do not "correct" it from memory.

**Resuming work?** `docs/roadmap.md` has a `CURRENT PHASE` marker and per-phase acceptance
checks. `docs/decisions.md` records why things are the way they are.

## Stack

Bun 1.4 (runtime, package manager, script runner, test runner) · Hono · `bun:sqlite` +
Drizzle + Drizzle Kit · Vite + React + TS · content-addressed object storage (local
filesystem).

## Layout

```
backend/     Bun + Hono API
dashboard/   Vite + React SPA
packages/
  types/       pure TS types, no runtime code, no deps
  protocol/    Expo Updates v1 — pure; no HTTP, no DB, no fs
  contracts/   Zod schemas + route defs — the single source of truth for the admin API
  api-client/  typed fetch client derived from contracts
  api-sdk/     ergonomic wrapper (uploads, polling) for future CLI/CI
  db/          Drizzle schema + bun:sqlite client + migrations
```

## Commands

All cwd-sensitive scripts run **from the repo root**. `bun run dev` uses `scripts/dev.ts`, which
spawns the API with the repo root as its cwd — `bun run --filter '*' dev` would run it from
`backend/`, where Bun would not find the root `.env`.

`config/env.ts` resolves `STORAGE_LOCAL_DIR`, `SIGNING_KEYS_DIRECTORY` and a relative `file:`
`DATABASE_URL` against `process.cwd()` — there is no repo-root anchoring or `.env` backfill.
This is safe only because every documented entry point already runs from the repo root:
`scripts/dev.ts` sets the API's cwd explicitly, and the Docker image sets `DATABASE_URL`,
`STORAGE_LOCAL_DIR` and `SIGNING_KEYS_DIRECTORY` as absolute paths via `ENV`. Do not run
backend scripts from inside `backend/` — see the "no such table: admins" entry in
`docs/troubleshooting.md`.

```bash
bun install
bun run dev            # API :3000 + Vite :5173 (Vite proxies /api → :3000)
bun test
bun run typecheck
bun run check          # biome lint + format check
bun run db:generate    # drizzle-kit generate
bun run db:migrate     # our own migrator — prod needs no drizzle-kit
bun run admin:create   # only way to create an admin; there is no registration route
```

PowerShell: `--filter '*'` needs single quotes. cmd.exe: use `"*"`.

## Never do

- **Never re-serialize a stored manifest.** `release_variants.manifest` holds the exact
  string that was signed. Re-serializing changes bytes and silently breaks every client
  signature check. It is plain `text()`, never `{ mode: 'json' }`.
- **Never query deployments without `application_id`.** Every OTA operation belongs to
  exactly one Application. There must be no code path that selects an update from
  channel/runtime/platform alone.
- **Never echo the client's `expo-runtime-version` into a manifest.** The official reference
  server does this; it is a bug. Emit the runtime version stored on the release variant.
- **Never write extracted ZIP contents to a filesystem.** Entries are inflated in memory and
  pushed straight to storage under a key derived from the hash *we* computed. This kills
  path traversal and symlink extraction structurally rather than by sanitization.
- **Never return 404 when there is no deployment.** Return 200 with a `noUpdateAvailable`
  directive.
- **Never respond `226 IM Used`** to an asset request carrying `A-IM: bsdiff`. Ignore the
  header, return a plain 200 with the full body.
- **Never read `device_installs` or `device_update_events` from the update-selection path.**
  Per-install tracking is read-only observability (D16); device *targeting* is a V2 non-goal
  (spec §55). The moment tracking data changes what a device is served, that line is gone.
- **Never log the value of `x-ota-user-id`.** It is app-supplied, may be anything, and is not in
  the logger's redaction list. `easClientId` is a random install UUID and is fine to log.
- No npm/npx/pnpm/yarn. No Node.js as the primary runtime. No Node-specific API where a Web
  standard or Bun built-in exists.
- No Postgres idioms: no native enums, no arrays, no `SERIAL`, no JSONB operators.
- No V2 features (see spec §55): no CI/CD, webhooks, percentage rollouts, device targeting,
  branches, delta updates, orgs, RBAC, billing.
- Never log passwords, session tokens, cookies, or private key material.

## Windows notes

- Binary/fixture files are `-text -diff` in `.gitattributes`. **Do not remove those rules.**
  Without them Git rewrites fixture line endings on checkout, changing their SHA-256 and
  producing test failures that look like crypto bugs.
- `openssl` is **not** on the PowerShell PATH. It ships with Git for Windows at
  `C:\Program Files\Git\usr\bin\openssl.exe`. Tests resolve it via `OPENSSL_BIN` →
  `Bun.which('openssl')` → that path, and skip loudly if absent.
- Storage keys are built with `path.posix` only. A `path.join` on Windows emits `sha256\ab\…`
  into local storage keys and into signed manifest URLs.
- Developer Mode is off — do not create symlinks; rely on Bun's junctions.

## Conventions

- Package names are `@ota/*`, all `private: true`, `type: module`, exporting raw `.ts` via
  `exports`. No build step for internal packages.
- IDs: `crypto.randomUUID()` in `text` primary keys. Update IDs must be UUID-formatted —
  the client calls `UUID.fromString` on them.
- Timestamps: `integer({ mode: 'timestamp_ms' })`. ISO strings appear only inside baked
  manifests.
- Multi-statement writes use `INSERT … ON CONFLICT DO UPDATE` upserts against a unique
  constraint, never read-modify-write. See D3 in `docs/decisions.md` — `db.batch()` is not
  actually used anywhere in the codebase; correctness comes from the constraint, not from a
  wrapping transaction.
- At the end of each phase: tick `docs/roadmap.md`, append any new decision to
  `docs/decisions.md`.
