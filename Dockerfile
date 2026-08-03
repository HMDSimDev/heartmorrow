# =============================================================================
# Heartmorrow — single-container image.
#
# Node 24 is REQUIRED: the server uses the built-in `node:sqlite` module
# (apps/server/src/db/sqlite.ts) with no --experimental-sqlite flag, which is
# only stable on Node 24. Because node:sqlite is built in, there are ZERO native
# dependencies to compile — a -slim base is enough, no build toolchain needed.
#
# The web client is built to static assets and served BY the Fastify server, so
# the container runs a single process on a single port (8787). The server runs
# TypeScript directly via tsx — a real dependency of @dsim/server, so it
# survives the prod-only install that strips build/test tooling below.
# =============================================================================

# ---- build: install deps + compile the web client --------------------------
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

# Copy only manifests first so `pnpm install` is cached until they change.
# pnpm-workspace.yaml carries `allowBuilds: esbuild: true`, required for the
# esbuild postinstall that tsx/vite depend on.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Now the sources, then build the web client -> apps/web/dist.
COPY . .
RUN pnpm --filter @dsim/web run build

# The web client is static files now, so drop every devDependency (vite,
# vitest, typescript, @redocly/cli, ...) — the runtime copy ships only what the
# server imports at runtime (tsx, fastify and friends). CI=true answers the
# "purge modules dir?" prompt that switching to prod-only triggers (no TTY here).
RUN CI=true pnpm install --prod --frozen-lockfile

# ---- runtime: run the Fastify server (serves API + web + uploads) -----------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    UPLOADS_DIR=/data/uploads

# HOST=0.0.0.0 binds the CONTAINER's interfaces only — it is NOT exposed to your
# LAN by itself. What exposes it is how you PUBLISH the port on the host; keep
# that bound to loopback (see docker-compose.yml) because the app has no auth.

# Copy the pruned workspace (incl. apps/web/dist) and run as non-root.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8787
VOLUME ["/data"]

# Liveness probe against the Fastify health route (Node 24 has global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Invoke tsx directly, NOT through pnpm: pnpm as PID 1 does not reliably
# forward SIGTERM, so `docker stop` would sit out the grace period and SIGKILL.
# tsx relays signals to the server, which shuts down cleanly (see index.ts).
# Container start therefore needs no pnpm/corepack/network at all.
CMD ["apps/server/node_modules/.bin/tsx", "apps/server/src/index.ts"]
