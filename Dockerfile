# syntax=docker/dockerfile:1

# Single Dockerfile, two build targets: `backend` and `dashboard`. Build with
# `docker build --target backend .` / `docker build --target dashboard .`, or
# see docker-compose.yml, which builds both from this file.
#
# No Postgres, Redis or Node containers — assets are content-addressed on the
# local filesystem and the database is a local SQLite file via bun:sqlite.
# Both live under /data, so a single volume is the whole persistent state.

# --- deps -------------------------------------------------------------------
# Shared by both targets below. Every workspace package.json must be copied
# here — root `package.json` declares workspaces ["backend", "dashboard",
# "packages/*"], and `bun install` resolves the whole workspace graph in one
# pass. Copying only e.g. backend/ and the packages/ (as the old split
# backend.Dockerfile/dashboard.Dockerfile each did) leaves `bun install`
# operating on an incomplete workspace set — the very bug this single-file
# layout exists to fix.
#
# Base image note: bun.lock is written by Bun 1.4, whose lockfile format
# (version 2) images older than 1.4 cannot read — `bun install` there fails
# with "Unknown lockfile version". Pinned to an exact version so builds are
# reproducible; keep both FROM lines on the same version when bumping.
FROM oven/bun:1.4.0 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY backend/package.json backend/
COPY dashboard/package.json dashboard/
COPY packages/types/package.json packages/types/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/
COPY packages/api-client/package.json packages/api-client/
COPY packages/api-sdk/package.json packages/api-sdk/
COPY packages/db/package.json packages/db/
COPY packages/cli/package.json packages/cli/
# --frozen-lockfile is on: a container build must fail rather than silently
# resolve something the lockfile does not describe. This was previously
# omitted because it "failed spuriously" on Bun 1.4-canary — that diagnosis
# was wrong. The real cause was a drifted bun.lock whose dashboard block
# recorded every dependency as "latest" while dashboard/package.json carried
# ^ ranges; regenerating the lockfile fixed it and the flag now passes.
RUN bun install --frozen-lockfile

# --- source -------------------------------------------------------------
# Full source layered on top of `deps`. Bun's linker creates workspace
# symlinks *inside* each member's own node_modules (e.g.
# backend/node_modules/@ota/db -> ../../../packages/db, an isolated/nested
# layout, not a single hoisted root node_modules) — those only exist once
# `bun install` has run against the full workspace, which happened in `deps`.
# COPY here layers real source (backend/src, packages/*/src, …) on top of
# that already-installed tree; Docker COPY merges into existing directories
# rather than replacing them, so the per-package node_modules symlinks survive
# underneath the freshly copied source files. Both `dashboard-build` and
# `backend` below pull from this stage rather than the raw build context, so
# neither loses those symlinks.
FROM deps AS source
WORKDIR /app
COPY . .

# --- dashboard-build ----------------------------------------------------
FROM source AS dashboard-build
WORKDIR /app
RUN bun run --cwd dashboard build

# --- backend ------------------------------------------------------------
# Workspace packages export raw TypeScript, so source is what ships — Bun
# transpiles on the fly and there is no separate backend build artifact.
FROM oven/bun:1.4.0-slim AS backend
WORKDIR /app
ENV NODE_ENV=production

COPY --from=source /app/node_modules ./node_modules
COPY --from=source /app/package.json /app/bunfig.toml ./
COPY --from=source /app/backend ./backend
COPY --from=source /app/packages ./packages

# The SQLite file and the content-addressed asset store both live here. This
# is the entire persistent state of the server — mount a volume over it, or
# everything is lost with the container.
RUN mkdir -p /data/storage /data/signing-keys && chown -R bun:bun /data
VOLUME /data

ENV DATABASE_URL=file:/data/ota.db \
    STORAGE_LOCAL_DIR=/data/storage \
    SIGNING_KEYS_DIRECTORY=/data/signing-keys \
    PORT=3000

# DASHBOARD_DIST is deliberately not set here: in this topology the
# `dashboard` target's nginx container serves the SPA, and the backend only
# needs to serve /api, /health and the OTA protocol routes. Set
# DASHBOARD_DIST yourself if you run this image standalone, without nginx in
# front of it.

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/health'); process.exit(r.ok ? 0 : 1)"

# The server applies Drizzle migrations itself on boot (backend/src/server.ts
# calls runMigrations() before it starts listening), so CMD does not need to
# run a separate migrate step.
CMD ["bun", "backend/src/server.ts"]

# --- dashboard ------------------------------------------------------------
FROM nginx:alpine AS dashboard
COPY --from=dashboard-build /app/dashboard/dist /usr/share/nginx/html
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
