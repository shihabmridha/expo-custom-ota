# Turso and libSQL

expo-custom-ota stores everything relational in libSQL. Three ways to run it, all the same schema and the
same generated SQL.

| Setup | `DATABASE_URL` | Driver |
|---|---|---|
| Local file | `file:./ota.db` | `bun:sqlite` |
| Local server (`turso dev`, `sqld`) | `http://localhost:8080` | `@libsql/client/web` |
| Turso cloud | `libsql://<db>-<org>.turso.io` + `DATABASE_AUTH_TOKEN` | `@libsql/client/web` |

The driver is chosen by URL scheme. `@libsql/client/web` is pure `fetch`, so there are no native
bindings to build — which is the main reason the remote path is predictable on Windows.

---

## The scheme gotcha

> ```
> TypeError: unknown certificate verification error
>   path: "https://localhost:8080/v2/pipeline"
>   code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"
> ```

**`libsql://` means "TLS required".** The client silently rewrites it to `https://`. A local
`turso dev` or `sqld` serves plain HTTP with no certificate, so the connection dies inside the
TLS handshake — and the error mentions only a certificate, never the scheme that caused it.

Fix, for a local server:

```bash
DATABASE_URL=http://localhost:8080          # preferred: unambiguous
DATABASE_URL=libsql://localhost:8080?tls=0  # or keep the scheme, opt out of TLS
```

For Turso cloud, `libsql://` is correct — those endpoints genuinely have TLS.

`createDb` checks for this specific combination (`libsql:` + a loopback host + no `tls=0`) and
throws a message naming the fix, so it fails at startup rather than as a certificate error on
the first query.

## Local development

The simplest option needs nothing installed:

```bash
DATABASE_URL=file:./ota.db
bun run db:migrate
```

To exercise the *remote* driver path locally — worth doing before deploying against Turso, since
it is a different code path — run a local server:

```bash
turso dev --port 8080          # or: sqld --http-listen-addr 127.0.0.1:8080
DATABASE_URL=http://localhost:8080 bun run db:migrate
```

## Turso cloud

```bash
turso db create oat
turso db show oat --url            # libsql://oat-<org>.turso.io
turso db tokens create oat         # DATABASE_AUTH_TOKEN
```

```bash
DATABASE_URL=libsql://oat-<org>.turso.io
DATABASE_AUTH_TOKEN=<token>
```

Migrations run automatically on container start, so a deploy cannot serve against an
out-of-date schema.

## SQLite semantics that matter here

**Foreign keys are off by default.** `bun:sqlite` does not enable them, so the client issues
`PRAGMA foreign_keys = ON` on every connection. Without it every foreign key in the schema would
be decorative — and the multi-application isolation tests would pass without proving anything.
There is a test asserting a violation actually throws.

**No native enums, arrays or `SERIAL`.** Statuses are `text` with a TS union and a CHECK
constraint; ids are `text` UUIDs generated app-side; timestamps are epoch-ms integers.

**Partial indexes work**, and one carries real weight:
`UNIQUE(application_id) WHERE status = 'active'` on signing keys enforces exactly one active key
per application in the database rather than in a service check that a concurrent request could
race.

**Upserts are the concurrency story.** Deployment writes are
`INSERT … ON CONFLICT (application_id, channel_id, platform, runtime_version) DO UPDATE`, never
read-modify-write. That suits libSQL over HTTP, where interactive transactions are awkward, and
makes concurrent-publish behaviour a property of the schema rather than of service code.

## Backups

Turso handles durability for cloud databases. For the local file, copy it while the server is
stopped, or use `VACUUM INTO`.

The database holds manifests and signatures but **not** private signing keys — those live on
disk under `SIGNING_KEYS_DIRECTORY` and are backed up separately. See
[deployment.md](deployment.md).
