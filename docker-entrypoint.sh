#!/usr/bin/env bash
# Container entrypoint: make sure the SQLite schema exists, optionally register
# slash commands, then hand off to the CMD (the bot process).
set -euo pipefail

# Fail fast with a clear, single message when the bot is misconfigured, instead
# of crash-looping on a Node stack trace deep inside the app.
missing=()
[ -z "${DISCORD_TOKEN:-}" ] && missing+=("DISCORD_TOKEN")
[ -z "${DISCORD_CLIENT_ID:-}" ] && missing+=("DISCORD_CLIENT_ID")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "[entrypoint] ERROR: missing required environment variable(s): ${missing[*]}" >&2
  echo "[entrypoint] Docker Compose reads these from the .env file (env_file: .env)." >&2
  echo "[entrypoint] Fix it:" >&2
  echo "[entrypoint]   1) cp .env.example .env   (if you have not already)" >&2
  echo "[entrypoint]   2) edit .env and set real values for DISCORD_TOKEN and DISCORD_CLIENT_ID" >&2
  echo "[entrypoint]   3) docker compose up -d --build" >&2
  exit 1
fi

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
