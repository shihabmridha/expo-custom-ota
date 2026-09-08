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

**Why:** the V1 spec document (`expo-oat.md` §11, §40) uses `x-ota-channel`, but EAS
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

## D14 — The update key and the application id stay separate; the error explains the difference

An Application has two identifiers that are generated by different functions and look nothing
alike: `id` is a `crypto.randomUUID()` primary key, and `updateKey` is the `ota_…` string that
forms the public updates URL. Every `/api/admin` route matches on the UUID; devices only ever send
the update key. Pasting the update key into the CLI's `--app` is the predictable mistake, because
the URL is the value a user actually has in front of them — it is the one in `app.json`.

`loadApplication` now does a second lookup by `updateKey` when the id misses, and returns a 404
naming the correct UUID. Admin routes were **not** changed to accept either value.

**Why not alias them:** the update key is a public, rotatable value; the id is a stable primary
key. Accepting either on the admin API lets the public URL and the admin surface drift into a
single conflated identifier, and would make a future key rotation a breaking API change. A better
error costs one lookup on a path that is already failing. The CLI also rejects a leading `ota_`
before packing, so the round-trip is skipped entirely.

## D15 — `@expo/config` is resolved the way the project would resolve it

`packages/cli` loads the target project's public Expo config to generate `expoConfig.json`. It
resolves `@expo/config` through a `createRequire` anchored at `<projectDir>/package.json`, not by
joining a path into `<projectDir>/node_modules`.

**Why:** the old path assumed dependencies sit in the project's own `node_modules` and that
`build/Config.js` is a stable entry point. Both are wrong. React Native requires exactly one copy
of each native module, so RN monorepos run hoisted linkers (Bun `linker = "hoisted"`, npm/yarn
workspaces, pnpm `node-linker=hoisted`) — in those layouts the app directory frequently has no
`node_modules` at all and `@expo/config` lives at the workspace root. `build/Config.js` is also a
private internal path that can move between SDK versions. Anchoring a `require` at the project's
own manifest walks up the `node_modules` chain exactly as an import from inside that project
would, and `getConfig` is exported from the package root, so no internal path is referenced.

**Interaction with D12:** the CLI ships as a bundle, and this must stay a *runtime* resolution
against the user's project — never something the bundler inlines. `bun build --target=node`
preserves the `createRequire(...)` call and leaves `@expo/config` external, because the specifier
is reached through a variable rather than a literal top-level `import`. Do not rewrite this to a
static `import` or a bare `require('@expo/config')`; either would make the bundler try to resolve
a package that only exists in someone else's project.

Relatedly, `pack` clears `dist/` before it runs `expo export`, and only when it owns that export.
`expo export` does not clear stale output, so switching `--platform all` to `--platform android`
otherwise leaves the previous iOS bundle behind and the archive advertises a platform it has no
current bundle for. Under `--skip-export` the caller owns `dist/` and it is left untouched.

## D16 — Per-install tracking exists, and is observability rather than targeting

`device_installs` (one upserted row per application × install) and `device_update_events` (an
append-only `served` / `confirmed` log) record which installs receive each update. Identity is
the `eas-client-id` every `expo-updates` client already sends, with two documented fallbacks:
an `install-id` in `expo-extra-params`, then an app-supplied `x-ota-user-id`. Controlled by
`DEVICE_TRACKING_ENABLED` (default true) and pruned by `bun run prune:devices` against
`DEVICE_TRACKING_RETENTION_DAYS` (default 90).

**Why, given §44 forbids it.** Spec §44 says "Do not build: user tracking, installation
tracking, detailed device analytics, update adoption analytics" and §55 lists "complex
analytics", "device targeting", "user targeting". This is a deliberate departure, requested
explicitly, and it is narrower than what those clauses forbid: nothing here targets anything.
`selectUpdate` is untouched and never reads either table — what a device is served still depends
only on (application, channel, platform, runtime version). The moment tracking data feeds
selection, this becomes the V2 feature the spec is refusing, so `CLAUDE.md` carries that as a
hard rule.

**Why two tables rather than the obvious event log.** An Expo app checks for updates on *every
launch*, so a row per request grows with launches × installs and needs a retention job on day
one. Instead the state table is upserted (bounded by install count) and the event log is appended
only on a transition, deduplicated by `uniqueIndex(application_id, client_id, update_id, kind)`.
Growth is installs × updates-they-touch × 2, independent of poll frequency. The unique index is
the mechanism, not a safety net: every append is `ON CONFLICT DO NOTHING` against it, which is
what replaces a read.

**Why `served` and `confirmed` are separate.** The server only knows it handed out a manifest.
Proof that an update actually launched arrives on the *next* request, as `expo-current-update-id`.
Recording only "served" overstates adoption by counting downloads that failed or were rejected
(a keyid mismatch, say). The gap between the two columns is the useful number.

**Reconciling with D3 (no read-modify-write, no transactions).** The state write is a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING`; `RETURNING` is the write's own output, not a second
statement, so the confirmation gate (`current_update_id != confirmed_update_id`) costs nothing
and cannot race with itself. The confirmed append is one `INSERT … SELECT … WHERE EXISTS (a
matching served row) ON CONFLICT DO NOTHING`. Advancing the gate afterwards is a compare-and-swap
on `current_update_id`. The sequence is self-healing rather than atomic: a crash or a device that
moves between statements leaves the gate open, and the next poll retries and hits `DO NOTHING` on
whatever was already written. No lost write produces a wrong answer, only a delayed one.

**The `WHERE EXISTS` is load-bearing for correctness.** Without it, an install reporting the
bundle embedded in its binary — an update id this server never issued — registers as adoption.
It is *not* a parser requirement: SQLite only rejects an upsert clause on an `INSERT … SELECT`
when the SELECT has a `FROM`, and this one does not (verified against SQLite 3.51.0).

**Cost.** Every device poll goes from one write transaction (`usage_daily`) to two. Under WAL
there is a single writer at a time with `busy_timeout = 5000`, so at high poll rates these
serialize; the design keeps the steady state to one row-update, which is the best achievable
without batching. `device_installs` carries four indexes, so that is four b-tree updates per
poll — `(application_id, current_update_id)` is the first to drop if write latency ever bites,
at the cost of a scan in the adoption query. Two further mitigations exist and are deliberately
**not** taken here: `PRAGMA synchronous = NORMAL` (a durability trade deserving its own record)
and a single write queue.

**Accepted limits.** An install served A → B → A logs `served(A)` once — the log means "first
time this install saw X", and `last_served_at` / `request_count` carry recency. Installs that
took an update before this shipped never emit `confirmed`. Pruning a `served` whose `confirmed`
never arrived means served/confirmed ratios spanning a retention boundary are not comparable.
A `user`-keyed row is one *user*, not one install, which is why `client_id_source` exists and is
surfaced in the dashboard.

**`x-ota-user-id` is unvalidated by construction.** Whatever the app sends is stored verbatim.
`sanitizeIdentifier` bounds length and charset; it cannot bound meaning. The defences are
documentation ("send an opaque id, not an email"), the off switch, retention, and keeping
`user_id` on the install row only — never denormalized into the event log — so scrubbing a user
is a single-table delete. It is also never logged: `updates.ts` logs `easClientId` and nothing
else, because `user_id` is not in the logger's redaction list.

## D17 — The CLI and the container images release on separate tags

`v*` publishes the container images (`docker-publish.yml`). `cli-v*` publishes the CLI to GitHub
Packages (`publish-cli.yml`). Both keep their `workflow_dispatch`.

**Why:** they were both on `v*`, and `publish-cli.yml` fails when the tag and
`packages/cli/package.json` disagree. So every server release — which is most releases, since the
backend and dashboard move far more often than the CLI — had to bump the CLI version purely to
satisfy that guard, republishing an unchanged package under a new number. `v0.1.2` is exactly
that: a device-tracking release that shipped CLI 0.1.2 with no CLI changes in it.

**Why not make the guard skip instead of fail.** That was considered and rejected: it reverses a
deliberate choice recorded in the workflow's own comment ("Fail here instead, before anything is
built"), and a silent skip cannot tell "the CLI genuinely did not change" apart from "someone
forgot to bump it".

**Why a tag rather than manual dispatch only.** Dispatch alone would be less machinery, but the
release identity would live only in Actions history. A tag keeps it in git, which is the same
reasoning behind `deployment_events` and this log.

**The non-obvious safety property:** GitHub's tag filters anchor at the start of the ref name, so
`cli-v0.1.3` does not match `v*`. The two tracks cannot trigger each other. That is what makes the
namespacing safe, and it is why the CLI prefix goes in front rather than at the end.

---

# Deviations from the V1 spec

Recorded because the spec document is otherwise authoritative. The spec (`expo-oat.md`) was
removed from the repo in 6954f00 — recover it with `git show 6954f00^:expo-oat.md`.

1. **`expo-channel-name` replaces `x-ota-channel`** in all examples — see D6. The spec doc is
   wrong relative to the real protocol.
2. **Five tables added** beyond §9's list: `sessions` (§34 cookie auth), `deployment_events`
   (objective #10, deployment history), `usage_daily` (§44 counters, with bounded storage), and
   `device_installs` + `device_update_events` (per-install tracking — see item 9 below and D16).
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
7. **A publishing CLI exists** (`packages/cli`) despite §55 listing one as a non-goal — see
   `docs/architecture.md`, which records why a scriptable packer is not the hosted build service
   the spec is refusing.
8. **Per-install tracking exists** despite §44's "do not build installation tracking / update
   adoption analytics" and §55's "device targeting" / "user targeting" — see **D16**. The
   departure is narrower than the prohibition: `device_installs` and `device_update_events` are
   read-only observability, and `selectUpdate` neither reads them nor ever may. Tracking answers
   "who received update X"; targeting would change *what* a device is served, and remains a
   non-goal.

## D18 — Device facts ride `expo-extra-params` and live on `device_installs`

`os-version`, `device-brand` and `device-model` are optional extra params an app sets with
`Updates.setExtraParamAsync` from `expo-device`. They are stored as three nullable columns on
`device_installs`, shown in the Devices tab, and filterable by exact match.

**Why extra params, not `requestHeaders`.** `updates.requestHeaders` is baked into the binary,
and the OS version changes underneath it. Extra params are runtime-settable, persisted by the
client library, and already the transport for `install-id`, so a client integrating one
integrates all of them the same way.

**Why the install table, not the event log.** `device_update_events` is the bounded append-only
funnel and stays narrow. A debugging session joins events to installs by client id anyway, and
brand does not change per event. Write semantics copy `user_id`: `coalesce(excluded, existing)`,
so an omitted param keeps the last known value and a changed one overwrites it. No new indexes —
this is a per-install lookup aid, not the headline query.

**A looser sanitiser.** `sanitizeIdentifier` forbids spaces, which rejects "Pixel 8 Pro".
`sanitizeLabel` allows printable ASCII including space, caps at 64 characters, and still rejects
rather than truncates so a stored value is always exactly what the device sent.

**The user-id transport was broken, and is fixed alongside.** `docs/client-setup.md` documented
`setExtraParamAsync('userId', …)`, but the server read the user id only from the `x-ota-user-id`
header, and a camelCase key fails RFC 8941 parsing and drops the *whole* dictionary — including
any `install-id` beside it. The parser now also accepts a `user-id` extra param (header wins), the
docs use that key, and a request whose `expo-extra-params` parses to nothing logs
`extra_params_unparsable` at debug level without the header value, so the failure is no longer
silent. Extra-param key constants live in `packages/protocol/src/headers.ts`.

**The D16 line holds.** Nothing in `selectUpdate` or the update path reads these columns. They
are app-supplied like the user id, so they are kept out of logs the same way (`CLAUDE.md`).
