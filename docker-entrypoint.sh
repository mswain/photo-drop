#!/bin/sh
set -e

# Apply database migrations before starting the server. Idempotent: Drizzle
# tracks which migrations have already run.
echo "Running database migrations…"
node /app/dist/migrate.cjs

echo "Starting Photo Drop on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}…"
exec node /app/server.js
