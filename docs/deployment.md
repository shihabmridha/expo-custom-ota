# Deployment

Two containers, one root `Dockerfile` with two build targets: `backend` (the Bun API) and
`dashboard` (nginx serving the built SPA and proxying `/api` and `/health` to `backend`). No
Postgres, Redis or Node containers.

```bash
export OTA_PUBLIC_URL=https://ota.example.com
export SESSION_SECRET="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
docker compose up -d
```

Then create the first administrator:

```bash
docker compose exec backend bun run backend/scripts/create-admin.ts \
  --email you@example.com --password 'a-long-password'
```

Migrations run automatically on every start, so a deploy cannot serve against an out-of-date
schema.

## Set OTA_PUBLIC_URL before your first publish

It is baked into signed manifests as the asset URL prefix. Changing it afterwards leaves
published manifests pointing at the old host, and they cannot simply be edited — that would
invalidate their signatures. The fix is to republish, so it is much cheaper to get right first.

The server refuses to start in production if it still points at localhost.

## Storage and database

Uses Bun's native SQLite (`bun:sqlite`) and local filesystem storage, both under `/data`.

| Component | Path | Description |
|---|---|---|
| Database | `/data/ota.db` | Local persistent SQLite database |
| Storage | `/data/storage` | Content-addressed asset objects |
| Keys | `/data/signing-keys` | Per-application RSA private signing keys |

## The /data volume

It holds the SQLite database file, asset objects, and — critically — the **private signing keys**.

Losing it means every application's signing key is gone. Since the certificate is embedded in
already-shipped binaries, those binaries can never receive another update: you would have to
generate new keys and ship new binaries through the app stores. Back it up.

## Reverse proxy

The `backend` container already sits behind the `dashboard` container's nginx, which proxies
`/api` and `/health` to it — `docker-compose.yml` sets `TRUST_PROXY=true` on `backend` for this
reason, so client IPs are read from `X-Forwarded-For` for rate limiting. Point your own
TLS-terminating reverse proxy at the `dashboard` container (`:80`), not directly at `backend`.

Make sure no proxy in the chain rewrites request or response bodies. The manifest signature is
over exact bytes; anything that re-encodes the body breaks verification.

Upload sizes need to be allowed through at every hop — the default limit is 500 MB
(`MAX_UPLOAD_BYTES`). The bundled `dashboard/nginx.conf` already sets `client_max_body_size` to
match; raise both together if you change `MAX_UPLOAD_BYTES`, and raise your own front-facing
proxy's limit too.

## Environment

See `.env.example` for the full list. In production the server refuses to start with a default
`SESSION_SECRET` or a localhost `OTA_PUBLIC_URL` — every problem is reported at once rather than
one per restart.

## Health

`GET /health` returns `{ ok, db, storage }` and 503 when either dependency is unreachable. The
container's healthcheck uses it.

## Base image constraint

The Dockerfile currently uses `oven/bun:canary`, not a pinned version: there is no published
`oven/bun:1.4` image yet, and `bun.lock` is written in Bun 1.4 lockfile format (version 2),
which the published 1.3 images cannot read — `bun install` fails there with "Unknown lockfile
version". Pin to `oven/bun:1.4` as soon as that image ships. Canary is not a stable base for
production.

`--frozen-lockfile` was previously omitted here, documented as Bun 1.4-canary spuriously
reporting "lockfile had changes". That diagnosis was wrong. The real cause was a drifted
`bun.lock`: its `dashboard` block recorded every dependency as the literal string `"latest"`
while `dashboard/package.json` carried `^` ranges, because the manifest was edited after the
last install. Regenerating the lockfile fixed it, and `--frozen-lockfile` is now on in the
Dockerfile. If it starts failing again, the lockfile is genuinely out of date — regenerate it
with `bun install` and commit the result rather than dropping the flag.

## Known limitations

**Rate limiting is in-memory.** It resets on restart and does not coordinate across instances.
V1 runs a single `backend` replica by design; running multiple replicas weakens the login limit
proportionally.

**Asset garbage collection is manual.** Run `bun run gc:assets` to report unreferenced assets and
`-- --apply` to delete them. It has a 7-day grace period, because storage writes deliberately
precede database rows during import.

**Sessions are swept lazily.** Expired sessions are rejected on use; run a periodic
`DELETE FROM sessions WHERE expires_at < …` if the table grows.

## Backups

Everything lives under the single `/data` volume, so one backup covers it:

- `/data/signing-keys` — irreplaceable, as above.
- `/data/ota.db` — application metadata, releases, manifests and signatures. Copy it while the
  server is stopped, or use SQLite's `VACUUM INTO` for a consistent snapshot without stopping it.
- `/data/storage` — content-addressed asset objects. A restore never conflicts, since a given
  hash always contains the same bytes.
