# expo-custom-ota roadmap

**CURRENT PHASE: 12 — VPS pass + iOS**

Phases 0–11 are complete: protocol, database, contracts, backend, importer, publishing, auth,
dashboard, Docker and docs. Every flow is verified end-to-end over real HTTP — upload, publish,
promote, roll back, kill-switch — with the served manifest signature confirmed by
`openssl dgst -verify`.

What remains needs physical devices.

Tick boxes as work lands. Each phase lists the acceptance check that proves it is done.
A phase is not done until its acceptance check actually passes — not when the code "looks right".

---

## Phase 0 — Workspace foundation

- [x] Root `package.json` with Bun workspaces (`backend`, `dashboard`, `packages/*`)
- [x] `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, path aliases)
- [x] `biome.json`, `bunfig.toml`
- [x] `.gitattributes` — fixture `-text -diff` rules (must precede any committed fixture)
- [x] `.gitignore`, `.env.example`
- [x] `CLAUDE.md`, `docs/protocol-notes.md`, `docs/roadmap.md`, `docs/decisions.md`
- [x] Package skeletons with `exports` pointing at raw `.ts`
- [x] `git init` + initial commit

**Acceptance:** `bun install && bun run typecheck && bun test && bun run check` all pass from a
clean clone.

## Phase 1 — `packages/types` + `packages/protocol`

- [x] `types`: platform, branded ids, release, deployment, expo-manifest, expo-export, storage
- [x] `protocol`: `sfv`, `headers`, `request`, `manifest`, `hash`, `signature`,
      `multipart`, `directives`, `response`, `export-metadata`, `selection-types`
- [x] Hand-rolled `multipart/mixed` writer (Web `FormData` cannot express per-part headers)
- [x] WebCrypto signing (`RSASSA-PKCS1-v1_5` / SHA-256)

**Acceptance:** `packages/protocol` imports nothing from `hono`, `drizzle-orm`, `@ota/db`, or
`node:fs`.

## Phase 2 — Protocol tests · **HARD GATE**

- [x] Checked-in **real** SDK 57 `expo export` fixture + signing fixtures
- [x] request parsing / manifest + hash encoding / multipart byte layout / directives
- [x] **Round-trip proof**: build response → extract manifest part → verify signature
- [x] **openssl interop**: `openssl dgst -sha256 -verify` says `Verified OK`

**Acceptance:** `bun test` green including openssl interop. Nothing downstream starts until this
passes — a wrong byte here invalidates every layer above it.

## Phase 3 — `packages/db`

- [x] Drizzle SQLite schema: admins, sessions, applications, application_signing_keys,
      channels, releases, release_variants, assets, release_assets, deployments,
      deployment_events, usage_daily
- [x] `PRAGMA foreign_keys = ON` on every connection (`bun:sqlite` defaults it OFF)
- [x] Single `bun:sqlite` driver via `drizzle-orm/bun-sqlite` (an earlier `libsql:`/`https:`
      driver split via `@libsql/client/web` was removed — see D11 in `docs/decisions.md`)
- [x] `drizzle.config.ts` with POSIX-normalised absolute paths (drizzle-kit resolves relative to
      cwd, and its glob engine treats `\` as an escape)
- [x] Constraint tests per spec §49

**Acceptance:** `bun run db:generate && bun run db:migrate` works from the repo root on Windows;
constraint tests green, including a FK violation that actually throws.

## Phase 4 — `contracts` / `api-client` / `api-sdk`

- [x] `RouteDef` + typed `PathParams<P>`; routes grouped by domain
- [x] `createApiClient` with response validation and typed `ApiError`
- [x] `api-sdk`: `uploadRelease`, `waitForImport`, `publishAndWait`
- [x] Backend `validated()` helper over `@hono/zod-validator`

**Acceptance:** deleting a field from a contract schema causes a compile error in **both**
backend and dashboard.

## Phase 5 — Backend skeleton + storage

- [x] Hono composition, `config/env.ts` (fail-fast Zod), context + error middleware
- [x] `AssetStorage` interface + `local` driver (an `r2` `Bun.S3Client` driver was added later
      and then removed — see D11 in `docs/decisions.md`)
- [x] Structured JSON logging with spec §43 event names and key redaction
- [x] In-memory rate limiting (moved to Phase 8, alongside the login route it protects)

**Acceptance:** `GET /health` returns `{ ok, version, dbOk, storageOk }`; a missing env var prints
every issue and exits non-zero; the storage driver passes its contract test.

## Phase 6 — Release importer

- [x] `ZipArchive` interface over `fflate` (escape hatch: `DecompressionStream('deflate-raw')`)
- [x] Path allowlist derived from `metadata.json` — read only what is named, never walk
- [x] Size / entry-count / ratio limits enforced pre-inflation **and** re-checked post-inflation
- [x] Raw `application/zip` upload body (not `formData` — Bun buffers that entirely)
- [x] Identity validation, runtime discovery, streaming hash, dedup, sign, draft release
- [x] State machine `uploaded → processing → assets_uploaded → ready | failed`, idempotency

**Acceptance:** uploading the fixture ZIP yields a `ready` draft whose manifest signature verifies
through the Phase 2 openssl path. Traversal / bomb / wrong-identity tests all reject.

## Phase 7 — Public endpoint + selection

- [x] `selectUpdate` with a **required** `applicationId`
- [x] `GET /api/v1/updates/:updateKey`, `GET /api/v1/assets/sha256/:shard/:hash`
- [x] Signed directives whenever `expo-expect-signature` was sent
- [x] `rollBackToEmbedded` deployment kill-switch, degrading safely without an embedded id

**Acceptance:** `curl` with the real client header set returns byte-correct multipart whose
manifest verifies under openssl. App A never receives App B's release.

## Phase 8 — Admin auth

- [x] argon2id via `Bun.password`, sessions storing only a token hash
- [x] Cookie flags per env, sliding expiry, logout, Origin-based CSRF check
- [x] Login rate limit (argon2id costs ~101 ms — an unlimited login route is a CPU DoS)
- [x] `admin:create` script; no registration route

**Acceptance:** a table-driven test enumerates the contracts registry and asserts every
`auth: 'admin'` route 401s unauthenticated — cannot go stale as routes are added.

## Phase 9 — Publish / promote / rollback

- [x] `ON CONFLICT DO UPDATE` deployment upserts; no read-modify-write on the deployment pointer
      (sequential statements otherwise — see the corrected D3 in `docs/decisions.md`, which flags
      the surrounding release/variant/asset writes as not actually atomic)
- [x] Promotion reuses the identical `release_variant_id` — no re-sign, no asset copy
- [x] Rollback creates a new release with fresh ids/manifests over the same asset rows
- [x] Published-release immutability

**Acceptance:** two concurrent publishes to the same 4-tuple leave exactly one deployment row and
two recorded events.

## Phase 10 — Dashboard

- [x] Routes per spec §36 + client-setup + simulator
- [x] TanStack Query with a key factory; upload progress via XHR; import polling stepper

**Acceptance:** full browser loop — create app → upload → publish → promote → rollback — with no
hard refresh.

## Phase 11 — Hardening, Docker, docs

- [x] Dockerfile; migrations on entrypoint
- [x] Docs per spec §57

**Acceptance:** the container(s) built from the Dockerfile serve both the API and the dashboard,
with migrations applied on start. (Originally a single Bun container serving the SPA directly;
the Docker layout was later split into separate `backend`/`dashboard` targets with nginx serving
the SPA — see `docs/deployment.md` for the current topology. The functional acceptance — one
`docker compose up` gets you a working API and dashboard — still holds.)

## Phase 12 — Real-device verification · **needs physical devices**

Full procedure: [device-verification.md](device-verification.md). Test app: `e2e/expo-test-app`.

- [x] **Android over LAN: all 9 steps pass** — see [device-verification-results.md](device-verification-results.md)
- [ ] Android against the VPS (`https://ota.acadion.xyz`) — needs a deploy and a rebuild
- [ ] iOS: same checklist, independently

**Acceptance:** signed OTA updates land on both platforms. V1 is not production-ready until this
passes (spec §61).

## Phase 13 — Distribution: CLI package and container images

- [x] `packages/cli` published to GitHub Packages as `@shihabmridha/expo-custom-ota`, built as a
      dependency-free bundle — see D12 in [decisions.md](decisions.md)
- [x] Cookie jar in `@ota/api-sdk` and an `XMLHttpRequest` guard in `@ota/api-client`, so the SDK
      works under Node and Bun rather than browsers only
- [x] One `Dockerfile` with `backend`/`dashboard` targets; images pushed to GHCR for amd64 and
      arm64 — see D13
- [x] CI on every PR: typecheck, lint, tests, CLI bundle smoke test, and both Docker targets built
- [ ] **After the first `v*` tag:** set the package to public at
      `github.com/shihabmridha?tab=packages → expo-custom-ota → Package settings → Change
      visibility`. GitHub Packages does not inherit visibility from the repository — a new package
      is private even from a public repo, so nobody but the owner can install it until this is
      done. It cannot be automated and it is irreversible.
- [ ] A tagged release verified end to end — install the published CLI in a scratch Expo project
      and publish an update through it

**Acceptance:** a developer with no access to this repository can install the CLI in their own
Expo app and ship an update to a server running the published images.
