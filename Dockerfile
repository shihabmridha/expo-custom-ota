# syntax=docker/dockerfile:1

# One container: the Bun backend serves /api and the built dashboard.
# No Postgres, Redis or Node containers — Turso is external, R2 holds assets.

# Base image note: bun.lock is written by Bun 1.4, whose lockfile format
# (version 2) the published 1.3 images cannot read — `bun install` there fails
# with "Unknown lockfile version". Until oven/bun:1.4 ships, the canary tag is
# the only published image new enough. Pin to `oven/bun:1.4` as soon as it
# exists; canary is not a stable base for production.
FROM oven/bun:canary AS deps
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
# NOTE: --frozen-lockfile is deliberately omitted. Bun 1.4-canary reports
# "lockfile had changes" even immediately after writing the lockfile itself, so
# the flag fails spuriously. bun.lock is still committed and still drives
# resolution. Restore --frozen-lockfile once Bun 1.4 is stable.
RUN bun install

FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run --cwd dashboard build

FROM oven/bun:canary-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Workspace packages export raw TypeScript, so source is what ships — Bun
# transpiles on the fly and there is no separate backend build artifact.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/bunfig.toml ./
COPY --from=build /app/backend ./backend
COPY --from=build /app/packages ./packages
COPY --from=build /app/dashboard/dist ./dashboard/dist

# Local libSQL file and local asset storage live here when the corresponding
# drivers are used. Mount a volume, or point at Turso and R2 instead.
RUN mkdir -p /data/storage /data/signing-keys && chown -R bun:bun /data
VOLUME /data

ENV DATABASE_URL=file:/data/ota.db \
    STORAGE_LOCAL_DIR=/data/storage \
    SIGNING_KEYS_DIRECTORY=/data/signing-keys \
    DASHBOARD_DIST=/app/dashboard/dist \
    PORT=3000

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/health'); process.exit(r.ok ? 0 : 1)"

# Migrations run before the server every start, so a deploy cannot serve against
# an out-of-date schema.
CMD ["sh", "-c", "bun run packages/db/src/migrate.ts && bun backend/src/server.ts"]
