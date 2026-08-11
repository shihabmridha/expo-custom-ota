# Decision log

Short records of choices that are expensive to reverse or that a future reader would otherwise
"fix" incorrectly. Append, don't rewrite.

---

## D1 — Sign once at import; store the exact serialized manifest string

`release_variants.manifest` is `TEXT` holding the literal `JSON.stringify` output that was
signed — never a re-serialized object, never Drizzle's `{ mode: 'json' }`. Serving is
`SELECT manifest, manifest_signature` and emitting those bytes verbatim.

**Why:** the Expo protocol has no canonicalization step. The client verifies the signature over
the exact bytes of the manifest part body. Any re-serialization — different key order, different
whitespace, a JSON round-trip — silently invalidates every signature. Storing the string makes
signature correctness a property of the importer, tested once, rather than of every request.

**Cost:** `OTA_PUBLIC_URL` is baked into asset URLs, so changing the domain after publishing
requires a re-sign maintenance command. Acceptable: `id` and `createdAt` are preserved, and
clients that already downloaded an update are unaffected.

## D2 — The importer never writes extracted ZIP contents to a filesystem

Entries are inflated into memory/streams and pushed straight to `AssetStorage` under a key
derived from the SHA-256 *we* computed. Storage keys are never derived from entry names.
Additionally we read only the paths named in `metadata.json` rather than walking the archive.

**Why:** this eliminates ZIP path traversal, absolute-path entries, and symlink extraction *by
construction* rather than by sanitization — there is no filesystem target to escape into. It also
removes Windows `EBUSY`-on-unlink temp-file races.

## D3 — Sequential statements with upsert-based concurrency, not transactions (corrected)

**This entry originally claimed every atomic multi-statement operation (publish, promote,
rollback, import commit) ran as a single `db.batch([...])`. That was never true — verified by
grep on 2026-08-11, there is zero use of `.batch(` and zero use of `.transaction(` anywhere in
`backend/` or `packages/`.**

What the code actually does: `publishRelease`, `promoteRelease`, `createRollbackRelease`
(`backend/src/services/publishing.ts`) and `importRelease`
(`backend/src/services/import/importer.ts`) each run as a **sequence of independently awaited**
`db.select` / `db.insert` / `db.update` / `db.run(sql...)` calls — no wrapping transaction of any
kind. Only the final deployment-pointer write in each operation is a single
`INSERT … ON CONFLICT DO UPDATE` against `UNIQUE(application_id, channel_id, platform,
runtime_version)`, and *that* statement's concurrency behaviour is genuinely deterministic: two
concurrent publishes to the same target leave exactly one row, last-writer-wins, both recorded in
`deployment_events` (spec §60).

Everything upstream of that final write — release-row allocation, `release_variants` and
`release_assets` insertion (one `INSERT` per asset row in the rollback and import paths, not a
batched array insert), and the import status transitions
(`uploaded → processing → assets_uploaded → ready | failed`) — has **no atomicity guarantee**. A
crash or connection drop mid-sequence can leave a `release_variants` row with no
`release_assets`, a deployed variant with no `deployment_events` audit row, or an import stuck at
`assets_uploaded`. The import path is documented (see D2's storage-before-row ordering, and the
comment at `importer.ts:36-38`) as relying on ordering and idempotent re-reads for the
storage/database split specifically, not on transactional atomicity for the SQL side.

**Why this was not caught sooner:** the deployment-pointer upsert is the statement that matters
for the correctness property this repo actually tests (`bun test` asserts two concurrent
publishes leave one row) — the other statements did not need to be batched to make that test
pass, so the gap in the surrounding writes went unexercised.

**Status: unresolved.** This decision record is corrected to describe reality, but the underlying
gap — no transactional wrapping around release/variant/asset row creation — is not fixed. Whether
`db.batch()` (or Drizzle's session-based `db.transaction()`, if `bun:sqlite` supports it well
enough) should wrap these sequences is an open question for whoever picks this up next; it was
out of scope for this cleanup pass, which only had a documentation mandate.

## D4 — Native `bun:sqlite` database client, zero external DB dependencies

The database layer uses Bun's built-in `bun:sqlite` driver exclusively via `drizzle-orm/bun-sqlite`.

**Why:** Native SQLite provides zero-dependency, ultra-high-performance local file database storage with zero network round trips or driver overhead. Schema is pure `sqlite-core`.

## D5 — The protocol package returns data, not `Response`

`packages/protocol` emits `{ status, headers, body: Uint8Array }`; the backend has a small
adapter to `Response`.

**Why:** keeps the package HTTP-framework-free and trivially testable without constructing
`Request`/`Response` pairs.

## D6 — The channel header is `expo-channel-name`

Read `expo-channel-name` first, accept `x-ota-channel` as a legacy fallback, then fall back to
`applications.default_channel`.

**Why:** the V1 spec document in this repo (`expo-oat.md` §11, §40) uses `x-ota-channel`, but EAS
and every existing Expo tool use `expo-channel-name`. Matching the ecosystem means an app already
configured for EAS Update needs only a URL change. All client-config snippets in the dashboard and
docs use `expo-channel-name`.

## D7 — Raw `application/zip` upload body, not `multipart/form-data`

`POST /api/admin/applications/:id/releases/import` takes a raw zip body; metadata travels in query
params and an `Idempotency-Key` header. Returns `202` with a release id; the dashboard polls.

**Why:** `req.formData()` in Bun buffers the entire body in memory — a 200 MB upload becomes
200 MB of RSS. A raw body is a `ReadableStream` we can tee into a hasher and into storage.

## D8 — Origin-check CSRF, no double-submit tokens

Session cookie is `HttpOnly; SameSite=Lax; Path=/`, `Secure` in prod. CSRF defence is an
Origin/Referer allowlist check on every non-GET `/api/admin/*` request.

**Why:** all admin mutations use `application/json` or `application/zip`, both of which force a
CORS preflight a cross-site page cannot satisfy; and `SameSite=Lax` already blocks cross-site
cookie attachment on non-GET. Double-submit tokens would add plumbing for no additional coverage.
Recorded here so it isn't "fixed" later.

## D9 — Dev runs same-origin through the Vite proxy

Vite proxies `/api` to `http://localhost:3000`, so `VITE_API_BASE_URL` is `""` in dev *and* prod.

**Why:** removes CORS configuration and makes cookie behaviour identical between dev and prod,
deleting a whole class of auth bugs that only appear in one environment.

## D10 — `config/env.ts` resolves paths against `process.cwd()`, with no repo-root anchoring

`STORAGE_LOCAL_DIR`, `SIGNING_KEYS_DIRECTORY` and a relative `file:` `DATABASE_URL` are resolved
against `process.cwd()`. An earlier version of `env.ts` located the workspace root and backfilled
from the root `.env` regardless of cwd; that defence-in-depth layer was removed.

**Why it is safe anyway:** every documented entry point already runs from the repo root.
`scripts/dev.ts` spawns the API with the repo root as its explicit cwd (Bun's script shell has no
background operator, so it supervises the child processes itself rather than relying on
`bun run --filter '*'`, which would run the backend from `backend/` and miss the root `.env`).
The Docker image sets `DATABASE_URL`, `STORAGE_LOCAL_DIR` and `SIGNING_KEYS_DIRECTORY` as absolute
paths via `ENV`, so cwd is irrelevant there regardless. The one way to get this wrong is running a
backend script directly from inside `backend/` — documented as a footgun in
`docs/troubleshooting.md` ("no such table: admins") rather than defended against in code a second
time.

## D11 — R2 and Turso/libSQL removed; local filesystem storage and `bun:sqlite` only

The R2 storage driver (`Bun.S3Client`) and the libSQL/Turso database driver
(`@libsql/client/web`, chosen by `libsql:`/`https:` URL scheme) were both deleted. Storage is
local filesystem only (`AssetStorage` has one implementation); the database is `bun:sqlite` only,
via `drizzle-orm/bun-sqlite`, regardless of environment.

**Why:** the driver split existed to support a scale-out deployment (remote object storage, a
managed SQLite-compatible service) that this project never actually ran in that configuration.
Carrying two storage drivers and two database drivers roughly doubled the surface area for
Windows-specific bugs (`@libsql/client`'s native N-API bindings, R2 credential handling) without
buying anything the local filesystem driver and `bun:sqlite` didn't already provide for a
single-container deployment. `bun:sqlite` has zero network round trips and no separate service to
operate; local filesystem storage lives on the same `/data` volume as the database and signing
keys, so a single volume backup covers everything. If a future deployment genuinely needs remote
object storage or a managed database, that is a new driver added back deliberately, not a
default carried since day one on the chance it might be needed.

## D12 — The CLI ships as a dependency-free bundle, not a package with dependencies

`packages/cli` is published to GitHub Packages as `@shihabmridha/expo-custom-ota`. It is built
with `bun build --target=node --format=esm`, which inlines everything it imports — `@ota/api-sdk`
and its `@ota/api-client`/`@ota/contracts`/`zod` graph, plus `commander` and `fflate` — into one
~0.6 MB `dist/cli.js`. Its published manifest declares **no** `dependencies`; every build input is
a `devDependency`, which npm strips from the tarball.

**Why:** the `@ota/*` packages are `private: true` and their `exports` point at raw `.ts`. Shipped
as real dependencies they would reference packages that exist on no registry, and even if
published, Node cannot execute their entry points. Bundling removes the problem at the root rather
than working around it. It also matters that this thing installs into *someone else's* Expo app: a
CLI with zero runtime dependencies cannot conflict with the host project's own version of `zod` or
anything else, and cannot be broken by that project's resolution rules.

Consequences worth knowing: `packages/cli/tsconfig.json` cannot inherit `noEmit`/
`allowImportingTsExtensions` semantics for emit (it does not use `tsc` to build at all — `tsc` is
typecheck-only there), and `package.json` needs an explicit `files` allowlist because
`.gitignore` ignores `dist/` and npm falls back to `.gitignore` when `files` is absent — without
it the published tarball is empty. The version lives in `package.json` alone; `cli.ts` imports it
rather than repeating it, and the release workflow fails if the git tag disagrees.

## D13 — One Dockerfile with named targets, images published to GHCR

There is a single root `Dockerfile` with `backend` and `dashboard` build targets sharing one
`deps` stage. `docker-compose.yml` and CI both select a target. Tagged releases push
`ghcr.io/shihabmridha/expo-custom-ota-{backend,dashboard}` for `linux/amd64` and `linux/arm64`.

**Why one file:** the split into `backend.Dockerfile` + `dashboard.Dockerfile` triplicated the
deps stage, and the copies had already drifted — each listed a *different* subset of workspace
`package.json` files, so `bun install` ran against an incomplete workspace set in both. A single
shared stage makes that class of drift impossible rather than something to notice in review.

**The non-obvious constraint:** Bun's linker creates workspace symlinks *inside each member's own*
`node_modules` (`backend/node_modules/@ota/db -> ../../../packages/db`), a nested layout rather
than one hoisted root `node_modules`. Those links only exist after `bun install` has run against
the full workspace. Copying `backend/` and `packages/` from the raw build context therefore
produces an image that fails at boot with `Cannot find module '@ota/db'`. Source is layered onto
the installed tree in a `source` stage instead — `COPY` merges into existing directories, so the
symlinks survive underneath. Do not "simplify" the runtime stage to copy from the build context.

---

# Deviations from `expo-oat.md`

Recorded because the spec document is otherwise authoritative.

1. **`expo-channel-name` replaces `x-ota-channel`** in all examples — see D6. The spec doc is
   wrong relative to the real protocol.
2. **Three tables added** beyond §9's list, each required by a stated objective the list doesn't
   cover: `sessions` (§34 cookie auth), `deployment_events` (objective #10, deployment history),
   `usage_daily` (§44 counters, with bounded storage).
3. **`deployments.release_variant_id` is nullable**, paired with a mutually-exclusive `directive`
   column (`rollBackToEmbedded` + `commit_time`) under a CHECK constraint. This is the only
   mechanism that un-ships a bad update to devices that already took it, without publishing new
   JS. The protocol already supports it.
4. **`AssetStorage` gains `get`/`stat`** — §41's interface cannot serve bytes, which the local dev
   driver must do.
5. **The local filesystem storage driver shipped first** (§41 implies R2 first), per the decision
   to make dev runnable with no external accounts. An R2 (`Bun.S3Client`) driver was added second
   and later removed entirely — see the R2/Turso removal entry below. Local filesystem storage is
   now the only driver, in dev and in production alike.
6. **Runtime version is stored, not echoed.** The official reference server copies the client's
   `expo-runtime-version` header into the manifest; we treat that as a bug and emit the value
   recorded on the release variant at import time.
