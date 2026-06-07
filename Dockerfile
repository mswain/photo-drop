# syntax=docker/dockerfile:1

# ---------- base: Node + pnpm via corepack ------------------------------------
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------- deps: install all dependencies (incl. dev, for building) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---------- builder: build the Next standalone app + bundled migrator ---------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build the Next.js app (output: "standalone") and self-contained CLI bundles
# (migrate.cjs runs on startup; create-admin.cjs bootstraps an admin account).
RUN pnpm run build && pnpm run build:migrate && pnpm run build:create-admin

# ---------- runner: minimal runtime image ------------------------------------
# The runner uses the self-contained Next standalone output + the bundled
# migrate.cjs, so it needs neither pnpm nor a node_modules tree.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Run as the unprivileged "node" user that ships with the base image.
# Standalone server output (includes its own trimmed node_modules + server.js).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Bundled, dependency-free CLIs: the migration runner + the SQL migrations it
# applies, and the admin-bootstrap tool (run manually, e.g. `dokku run`).
COPY --from=builder --chown=node:node /app/dist/migrate.cjs ./dist/migrate.cjs
COPY --from=builder --chown=node:node /app/dist/create-admin.cjs ./dist/create-admin.cjs
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh

USER node
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
