#!/usr/bin/env bash
# Container entrypoint: make sure the SQLite schema exists, optionally register
# slash commands, then hand off to the CMD (the bot process).
set -euo pipefail

# Apply the Prisma schema to the (volume-mounted) SQLite database. Idempotent.
echo "[entrypoint] Applying database schema…"
npx prisma db push --skip-generate

# Register the /moderation slash command once by starting the container with
# DEPLOY_COMMANDS=true (e.g. `DEPLOY_COMMANDS=true docker compose up`).
if [ "${DEPLOY_COMMANDS:-false}" = "true" ]; then
  echo "[entrypoint] Registering slash commands…"
  node dist/deployCommands.js
fi

echo "[entrypoint] Starting: $*"
exec "$@"
