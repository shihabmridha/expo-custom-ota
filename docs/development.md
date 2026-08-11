# Development

Bun 1.4+ is the only prerequisite. The default configuration uses Bun's native SQLite (`bun:sqlite`) and local
filesystem storage, so nothing external is needed to run or test.

```bash
bun install
bun run db:migrate
bun run admin:create -- --email you@example.com --password 'a-long-password'
bun run dev
```

API on `:3000`, dashboard on `:5173`. Vite proxies `/api` to the backend, so the dashboard is
**same-origin in development and production alike** — no CORS configuration, and cookie
behaviour is identical in both.

## Run scripts from the repository root

Bun loads `.env` from the working directory, and `file:./ota.db` and `./.storage` resolve from
it too. Running a database script from inside `packages/db` would silently create a second,
empty database. All cwd-sensitive scripts therefore live in the root `package.json`.

PowerShell needs single quotes for the filter glob: `bun run --filter '*' typecheck`. cmd.exe
needs double quotes.

## Tests

```bash
bun test                              # everything
bun test packages/protocol            # protocol only
bun test backend/tests/import.test.ts # one file
```

Four layers:

- **`packages/protocol/tests`** — request parsing, manifest and hash encoding, multipart byte
  layout, directives, signing. Includes an `openssl dgst -verify` cross-check, which is the only
  test that proves our signatures are valid outside our own crypto code.
- **`packages/db/tests`** — every constraint, asserted against the generated migration SQL. Also
  proves foreign keys are actually enforced, since `bun:sqlite` leaves them off by default and
  the isolation tests would otherwise pass vacuously.
- **`backend/tests`** — HTTP integration against an in-memory database: the update endpoint,
  multi-application isolation, importer security, publishing, auth.
- **Contract-driven** — the auth suite enumerates the contract registry and asserts every
  `auth: 'admin'` route rejects unauthenticated requests, so a new route cannot be added without
  being covered.

## Fixtures

`packages/protocol/tests/fixtures/expo-export-sdk57/` is a **real** `expo export`, not
hand-written. See its `FIXTURE.md` for how it was produced and what properties it pins.

Fixtures are `-text -diff` in `.gitattributes`. Do not remove those rules: Git's line-ending
conversion would rewrite them on a Windows checkout, changing their SHA-256 and breaking every
hash and signature test in a way that looks exactly like a crypto bug.

## Working on the protocol

Read `docs/protocol-notes.md` first. It is researched ground truth — the published spec, the
official reference server, and the actual client source, with the places they disagree marked.
Do not re-derive it from memory; several of the details are counter-intuitive (signature and
hash use *different* base64 alphabets, and "no update" is a 200, not a 404).

`packages/protocol` must not import from Hono, Drizzle, `@ota/db` or `node:fs`. Keeping it pure
is what makes it testable without a server.

## Adding an endpoint

1. Add the route and its schemas to `packages/contracts`.
2. Implement it in `backend/src/routes/admin/` with `handle(contracts.x.y, …)`, which gives you
   a typed, validated body and query.
3. The typed client method appears automatically — `api-client` is generated from the registry.

Deleting a field from a contract schema breaks compilation in both the backend and the
dashboard, which is the point.

## Database changes

```bash
bun run db:generate   # writes a migration from the schema
bun run db:migrate    # applies it
```

Migrations are committed. SQLite conventions: `text` UUID primary keys, `integer` epoch-ms
timestamps, JSON as `text`, statuses as `text` plus a CHECK constraint. No Postgres enums,
arrays or `SERIAL`.

`release_variants.manifest` is plain `text`, deliberately **not** Drizzle's `{ mode: 'json' }` —
it holds the exact string that was signed, and parsing plus re-serializing would invalidate
every signature.

## Windows notes

- `openssl` ships with Git but is not on the PowerShell PATH. Tests find it at
  `C:\Program Files\Git\usr\bin\openssl.exe` or via `OPENSSL_BIN`, and skip loudly otherwise.
- Storage keys and archive paths use `path.posix` only. A `path.join` here emits backslashes
  into storage keys and signed manifest URLs.
- `expo export` on Windows writes asset paths in `metadata.json` with backslashes. The importer
  normalises them; the fixture pins the behaviour.

## Trying it end to end without a device

```bash
bun run backend/scripts/dev-seed.ts   # seeds an app + release from the checked-in fixture
bun run dev:api
curl -sS -D - \
  -H "Accept: multipart/mixed" -H "Expo-Platform: android" \
  -H "Expo-Protocol-Version: 1" -H "Expo-Runtime-Version: 1.0.0" \
  -H "expo-channel-name: production" \
  -H 'expo-expect-signature: sig, keyid="main"' \
  http://localhost:3000/api/v1/updates/ota_devfixture000000
```

Or use the dashboard's **Simulator** tab, which does the same thing and verifies the signature
for you.
