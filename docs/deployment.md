# Deployment

One container: the Bun backend serves `/api/*` and the built dashboard. No Postgres, Redis or
Node containers.

```bash
export OTA_PUBLIC_URL=https://ota.example.com
export SESSION_SECRET="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
docker compose up -d
```

Then create the first administrator:

```bash
docker compose exec oat bun run backend/scripts/create-admin.ts \
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

Defaults are a local libSQL file and local filesystem storage, both under `/data`. Both are pure
environment swaps:

| | Local (default) | Production |
|---|---|---|
| Database | `DATABASE_URL=file:/data/oat.db` | `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN` |
| Storage | `STORAGE_DRIVER=local` | `STORAGE_DRIVER=r2` + `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |

Set `R2_PUBLIC_URL` to serve asset bytes straight from the bucket instead of proxying them
through the backend. Manifests then point at the bucket directly, which is what you want at any
real traffic level.

## The /data volume

It holds the libSQL file (if local), asset objects (if local), and — critically — the **private
signing keys**.

Losing it means every application's signing key is gone. Since the certificate is embedded in
already-shipped binaries, those binaries can never receive another update: you would have to
generate new keys and ship new binaries through the app stores. Back it up.

If you use Turso and R2, only `/data/signing-keys` matters, and mounting it as a read-only
secret is better than a volume.

## Reverse proxy

Terminate TLS in front and forward to `:3000`. Set `TRUST_PROXY=true` so client IPs are read
from `X-Forwarded-For` for rate limiting.

Make sure the proxy does not rewrite request or response bodies. The manifest signature is over
exact bytes; anything that re-encodes the body breaks verification.

Upload sizes need to be allowed through — the default limit is 500 MB
(`MAX_UPLOAD_BYTES`). nginx needs `client_max_body_size` raised to match.

## Environment

See `.env.example` for the full list. In production the server refuses to start with a default
`SESSION_SECRET`, a localhost `OTA_PUBLIC_URL`, or `STORAGE_DRIVER=r2` without R2 credentials —
every problem is reported at once rather than one per restart.

## Health

`GET /health` returns `{ ok, db, storage }` and 503 when either dependency is unreachable. The
container's healthcheck uses it.

## Base image constraint

The Dockerfile currently uses `oven/bun:canary`, not a pinned version. Two reasons, both
temporary:

- There is no published `oven/bun:1.4` image yet, and `bun.lock` is written in Bun 1.4 lockfile
  format (version 2), which the published 1.3 images cannot read — `bun install` fails there with
  "Unknown lockfile version".
- `--frozen-lockfile` is omitted because Bun 1.4-canary reports "lockfile had changes" even
  immediately after writing the lockfile itself. `bun.lock` is still committed and still drives
  resolution.

Pin to `oven/bun:1.4` and restore `--frozen-lockfile` as soon as that image ships. Canary is not
a stable base for production.

## Known limitations

**Rate limiting is in-memory.** It resets on restart and does not coordinate across instances.
V1 is single-container by design; running multiple replicas weakens the login limit
proportionally.

**Asset garbage collection is manual.** Run `bun run gc:assets` to report unreferenced assets and
`-- --apply` to delete them. It has a 7-day grace period, because storage writes deliberately
precede database rows during import.

**Sessions are swept lazily.** Expired sessions are rejected on use; run a periodic
`DELETE FROM sessions WHERE expires_at < …` if the table grows.

## Backups

- `/data/signing-keys` — irreplaceable, as above.
- The database — application metadata, releases, manifests and signatures. Turso handles this;
  for the libSQL file, copy it while the server is stopped or use `VACUUM INTO`.
- Object storage — R2 durability is usually sufficient. Assets are content-addressed, so a
  restore never conflicts.
