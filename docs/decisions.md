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

## D3 — `db.batch()`, not interactive transactions

Every atomic multi-statement operation (publish, promote, rollback, import commit) is a single
`db.batch([...])`, which libSQL executes atomically in one round trip and which `bun:sqlite` also
supports. Concurrency correctness comes from unique constraints plus
`INSERT … ON CONFLICT DO UPDATE`, never read-modify-write.

**Why:** libSQL over HTTP has awkward interactive-transaction support in Drizzle, and
read-modify-write on deployments would allow two concurrent publishes to interleave. Upserts
against `UNIQUE(application_id, channel_id, platform, runtime_version)` make the outcome
deterministic (spec §60).

## D4 — Driver-split DB client, zero native dependencies

`file:` URL → `drizzle-orm/bun-sqlite` + `bun:sqlite` (dev, Windows, tests).
`libsql://` / `https://` → `drizzle-orm/libsql` + `@libsql/client/web` (pure fetch).

**Why:** avoids `@libsql/client`'s native N-API bindings, which are the single least predictable
part of this stack under Bun on Windows. Schema is shared `sqlite-core`; generated SQL is
identical for both.

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
5. **The local filesystem storage driver ships first**, R2 second (§41 implies R2 first), per the
   decision to make dev runnable with no external accounts.
6. **Runtime version is stored, not echoed.** The official reference server copies the client's
   `expo-runtime-version` header into the manifest; we treat that as a bug and emit the value
   recorded on the release variant at import time.
