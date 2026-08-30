# Deployment

Two containers, one root `Dockerfile` with two build targets: `backend` (the Bun API) and
`dashboard` (nginx serving the built SPA and proxying `/api` and `/health` to `backend`). No
Postgres, Redis or Node containers.

```bash
export OTA_PUBLIC_URL=https://ota.example.com
export SESSION_SECRET="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
docker compose up -d
```

Then create the first administrator (the only way — there is no registration route):

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

## The /data volume

Everything persistent lives under one volume:

| Path | Holds |
|---|---|
| `/data/ota.db` | SQLite database: applications, releases, manifests, signatures |
| `/data/storage` | Content-addressed asset objects |
| `/data/signing-keys` | Per-application RSA **private signing keys** |

**Back it up.** The signing keys are irreplaceable: the certificate is embedded in
already-shipped binaries, so losing the keys means those binaries can never receive another
update — you would have to ship new binaries through the app stores. Copy `ota.db` while the
server is stopped, or use SQLite's `VACUUM INTO` for a consistent snapshot without stopping it.
Asset objects restore without conflict, since a given hash always contains the same bytes.

## Reverse proxy

Point your TLS-terminating reverse proxy at the `dashboard` container (`:80`), not directly at
`backend` — nginx there already proxies `/api` and `/health` through, and `docker-compose.yml`
sets `TRUST_PROXY=true` on `backend` so client IPs come from `X-Forwarded-For`.

Two constraints on every hop in the chain:

- **No body rewriting.** The manifest signature is over exact bytes; anything that re-encodes
  the response breaks verification.
- **Allow large uploads.** The default limit is 500 MB (`MAX_UPLOAD_BYTES`); the bundled
  `dashboard/nginx.conf` sets `client_max_body_size` to match. Raise both together, plus your
  own front proxy's limit.

## Environment

See `.env.example` for the full list. In production the server refuses to start with a default
`SESSION_SECRET` or a localhost `OTA_PUBLIC_URL` — every problem is reported at once rather than
one per restart.

Device tracking: `DEVICE_TRACKING_ENABLED` (default `true`) records one row per install —
random install UUID, platform, channel, runtime version, which update it runs, timestamps; no
IP, no user agent — powering the dashboard's **Devices** tab. Set it `false` to store no device
identifiers at all. `DEVICE_TRACKING_RETENTION_DAYS` (default `90`, `0` = forever) is the age at
which `bun run prune:devices` drops rows. See `client-setup.md` for the optional
`x-ota-user-id` header.

## Health

`GET /health` returns `{ ok, db, storage }` and 503 when either dependency is unreachable. The
container's healthcheck uses it.

## Base image

The Dockerfile pins `oven/bun:1.4.0` (and `1.4.0-slim` for the runtime stage). Images older
than 1.4 cannot read `bun.lock`'s format and fail with "Unknown lockfile version". When
bumping, change both `FROM` lines together. If `--frozen-lockfile` fails in the build, the
lockfile is genuinely out of date: regenerate with `bun install` and commit it rather than
dropping the flag.

## Known limitations

- **Rate limiting is in-memory.** It resets on restart and does not coordinate across
  instances. V1 runs a single `backend` replica by design.
- **Asset garbage collection is manual.** `bun run gc:assets` reports unreferenced assets,
  `-- --apply` deletes them, with a 7-day grace period (storage writes deliberately precede
  database rows during import).
- **Sessions are swept lazily.** Expired sessions are rejected on use; run a periodic
  `DELETE FROM sessions WHERE expires_at < …` if the table grows.
- **Device-tracking retention is manual.** `bun run prune:devices -- --apply` ages out installs
  that are gone — a good nightly cron job alongside `gc:assets`.
