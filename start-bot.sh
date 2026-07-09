#!/usr/bin/env bash
#
# start-bot.sh — one-command launcher for the AI Discord Moderator (bare metal).
#
# Usage:
#   ./start-bot.sh            Build once and run in production mode
#   ./start-bot.sh --dev      Run in watch/dev mode (tsx, auto-reload)
#   ./start-bot.sh --deploy   Also (re)register the /moderation slash command
#   ./start-bot.sh --deploy --dev
#
# It installs dependencies, generates the Prisma client, creates/updates the
# SQLite database, optionally registers slash commands, then starts the bot.
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
start-bot.sh — one-command launcher for the AI Discord Moderator (bare metal).

Usage:
  ./start-bot.sh            Build once and run in production mode
  ./start-bot.sh --dev      Run in watch/dev mode (tsx, auto-reload)
  ./start-bot.sh --deploy   Also (re)register the /moderation slash command
  ./start-bot.sh --deploy --dev

Installs dependencies, generates the Prisma client, creates/updates the SQLite
database, optionally registers slash commands, then starts the bot.
USAGE
}

DEV=0
DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --deploy) DEPLOY=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# ── Node version check ───────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required but 'node' was not found." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found $(node -v))." >&2
  exit 1
fi

# ── .env bootstrap ───────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "No .env found — creating one from .env.example."
  cp .env.example .env
  echo "Edit .env and set DISCORD_TOKEN, DISCORD_CLIENT_ID and ALLOWED_GUILD_IDS, then re-run." >&2
  exit 1
fi

# ── Dependencies ─────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

# ── Prisma: client + database schema ─────────────────────────────────────────
echo "Generating Prisma client…"
npx prisma generate
echo "Applying database schema…"
npx prisma db push --skip-generate

# ── Optional: register slash commands ────────────────────────────────────────
if [ "$DEPLOY" -eq 1 ]; then
  echo "Registering slash commands…"
  npm run deploy-commands
fi

# ── Launch ───────────────────────────────────────────────────────────────────
if [ "$DEV" -eq 1 ]; then
  echo "Starting in dev (watch) mode…"
  exec npm run dev
else
  echo "Building…"
  npm run build
  echo "Starting…"
  exec npm start
fi
