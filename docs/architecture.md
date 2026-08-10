# Architecture

```
                       ┌──────────────────────────────┐
   Developer ──export──▶│  dashboard (Vite + React)    │
                       └──────────────┬───────────────┘
                                      │ /api/admin/*  (cookie session)
                       ┌──────────────▼───────────────┐
   Device ─────────────▶│  backend (Bun + Hono)        │
        /api/v1/updates └───┬───────────────────┬──────┘
                            │                   │
                    ┌───────▼──────┐    ┌───────▼────────┐
                    │ libSQL/Turso │    │ object storage │
                    │  (Drizzle)   │    │  local  or R2  │
                    └──────────────┘    └────────────────┘
```

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `types` | Domain and protocol types. No runtime code. | — |
| `protocol` | Expo Updates v1: parsing, manifests, multipart, signing, directives. Pure — no HTTP, no database, no filesystem. | `types` |
| `contracts` | Zod schemas + route definitions. The single source of truth for the admin API. | `types` |
| `api-client` | Typed fetch client generated from `contracts`. | `contracts` |
| `api-sdk` | Ergonomic wrapper: uploads, polling, publish-and-wait. | `api-client` |
| `db` | Drizzle schema, libSQL client, migrations. | `types` |
| `backend` | Hono app, services, storage drivers. | all |
| `dashboard` | Admin SPA. | `api-client` |

`protocol` importing nothing from Hono, Drizzle or `node:fs` is a deliberate constraint: it is
the part that must be exactly right, and keeping it pure makes it testable without a server or a
database.

## The invariants

These are load-bearing. Breaking any of them is a correctness or security bug, not a style
question.

### Every operation belongs to exactly one application

No release, channel, deployment, signing operation or update selection happens without an
explicit owning application. Enforced three ways: `applicationId` is a required field of
`SelectUpdateInput`; every query filters on it; and
`UNIQUE(application_id, channel_id, platform, runtime_version)` makes the tuple meaningless
without it. Two applications sharing a channel name, platform and runtime version is normal and
must never cross over.

### Manifests are serialized once and stored as bytes

The Expo protocol has **no canonicalization step**. The client verifies the signature over the
exact bytes of the manifest part body. So `release_variants.manifest` is plain `TEXT` holding
the literal string that was signed, and serving is "read column, emit". Re-serializing — even
`JSON.parse` followed by `JSON.stringify` — silently invalidates every signature.

This makes signature correctness a property of the importer, tested once, rather than of every
request.

### Runtime version comes from the release, not the request

The official reference server copies the client's `expo-runtime-version` header into the
manifest, which means it asserts whatever the client claims. expo-custom-ota stores the runtime version per
release variant at import time and emits that.

### Published releases are immutable

`update_id`, `runtime_version`, `platform`, `manifest`, `manifest_signature`, `launch_asset_id`
and `created_at` never change after creation. Changing content means a new release. Published
releases can be archived, not mutated; only drafts can be deleted.

### Assets are immutable and content-addressed

Storage keys are `sha256/<ab>/<full-hex>` and the bytes at a key never change, so identical
assets are shared across releases, runtime versions and applications. This is why assets are
never cascade-deleted — removal is reference-counted garbage collection.

### Storage writes precede database rows

An orphaned object is harmless and gets collected. An orphaned row serves a manifest pointing at
bytes that do not exist. The import state machine
(`uploaded → processing → assets_uploaded → ready | failed`) makes the ordering explicit and
keeps a half-imported release unpublishable.

## Update selection

```
GET /api/v1/updates/:updateKey
  → resolve application by update_key                    (404 if unknown)
  → parse protocol headers                               (400/405/406 on error)
  → channel = expo-channel-name ?? default
  → selectUpdate(applicationId, channel, platform, runtime, currentUpdateId)
      ├─ no deployment          → 200 + noUpdateAvailable directive
      ├─ current == deployed    → 200 + noUpdateAvailable directive
      ├─ rollback deployed      → 200 + rollBackToEmbedded directive
      └─ otherwise              → 200 + stored manifest bytes + stored signature
```

"No update" is a **200 with a directive**, never a 404. A 404 would make the client treat a
perfectly healthy server as broken.

## Concurrency

Every deployment write is `INSERT … ON CONFLICT (application_id, channel_id, platform,
runtime_version) DO UPDATE`. There is no read-modify-write anywhere in the publishing path, so
two administrators publishing different releases to the same target concurrently always leave
exactly one row — last writer wins deterministically, and both attempts appear in
`deployment_events`.

Release numbers are allocated with a single `INSERT … SELECT COALESCE(MAX(release_number),0)+1`,
backed by `UNIQUE(application_id, release_number)`.

## Authentication

Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` in production. The cookie carries 32
random bytes; only their SHA-256 is stored, so a database dump cannot be replayed.

CSRF is handled by an **Origin allowlist on non-GET `/api/admin/*`**, not double-submit tokens.
That is complete here because every admin mutation uses `application/json` or `application/zip`
— both force a CORS preflight a cross-site page cannot satisfy — and `SameSite=Lax` already
blocks cross-site cookie attachment on non-GET. Documented so it is not "fixed" into something
more complicated later.

Login is rate limited to 5 attempts per 15 minutes per IP+email. This is not optional:
`Bun.password` argon2id costs roughly 100 ms of CPU per verify, so an unlimited login route is a
denial-of-service vector.

## Signing

Each application has its own RSA-2048 key, so a compromise is contained. Certificates are
generated with `@expo/code-signing-certificates` — Expo's own library — so the extensions match
what the client validates exactly.

Private keys live on disk under `SIGNING_KEYS_DIRECTORY` (a mounted secret in production). They
are never stored in the database, never returned by the API, and never reach the dashboard —
the API does not even expose their filenames.

## What is deliberately not here

No CI/CD or Git integration, webhooks, percentage rollouts, A/B testing, device or user
targeting, branches, delta updates, organisations, RBAC, billing, public signup, or publishing
tokens. See `expo-oat.md` §55.
