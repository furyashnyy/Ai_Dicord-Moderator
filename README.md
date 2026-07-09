# AI Discord Moderator

A Discord moderation bot (**TypeScript + discord.js v14**) that moderates a
server **according to the rules the server owner writes in a rules channel** —
not a universal blocklist. The same word can be allowed on one server and
banned on another; the **single source of truth is the text of that server's
rules channel**.

Moderation runs **locally** with lightweight AI (ONNX / CPU via
`@xenova/transformers`) plus a RU + EN profanity lexicon, so it understands
**Russian mat and insults**, not only English.

---

## How it works

```
message ─► [1] keyword fast-pass ─► matched? ─► punish per the matched rule
                    │ no
                    ▼
           [2] AI pass:
               • toxicity classifier  (score + category)
               • embedding of message ↔ embedding of each rule (cosine)
                    │ best rule above its similarity threshold?
                    ▼ yes ─► punish per that rule
                    │ no
                    ▼
           [3] high general toxicity + no rule matched
                    └► guild's configurable default-action (ignore/warn/delete)
```

Key principle (task §3): on a server where profanity is allowed, general
toxicity **does not** punish on its own — only what the rules channel forbids
is enforced. Step 3 only fires if the owner opts in via `default-action`.

### The two-signal detector

- **RU + EN lexicon** (`src/ai/lexicon.ts`) — fast, precise detection of
  specific words, resilient to obfuscation (leetspeak, Latin/Cyrillic
  homoglyphs like `xyecoc` → `хуесос`, spacing like `с у к а`, char
  repetition). Used both to match a rule's explicit keywords **and** to produce
  a general-toxicity signal.
- **ML toxicity classifier** — contextual toxicity (sarcasm, threats, veiled
  insults) the lexicon can't catch. The final toxicity score is `max(model,
  lexicon)` so each covers the other's blind spots.
- **Multilingual embeddings** (`paraphrase-multilingual-MiniLM-L12-v2`, RU+EN)
  — semantic matching of a message to the most relevant **rule text**.

### Graceful degradation (no stubs)

Model loading is best-effort and lazy. If a model can't be downloaded (offline
first run) or you disable it to save RAM, the bot logs a warning and keeps
running on the remaining paths — the lexicon + keyword path works **fully
offline** with essentially no extra RAM. See `ENABLE_TOXICITY_MODEL` /
`ENABLE_EMBEDDINGS`.

---

## Requirements

- **Node.js 20+**
- A Discord application + bot token with the **Message Content** privileged
  intent enabled (Developer Portal → your app → Bot → Privileged Gateway
  Intents). The bot also needs the **Server Members** intent is *not* required,
  but the bot role needs `Moderate Members`, `Kick Members`, `Ban Members`,
  and `Manage Messages` permissions in the server to act.

Memory: both models quantized (int8) fit within ~1 GB alongside Node. If that's
too tight, set `ENABLE_EMBEDDINGS=false` (keeps toxicity model + lexicon) or
`ENABLE_TOXICITY_MODEL=false` (lexicon-only, near-zero extra RAM).

---

## Setup

First, configure the environment (both launch methods need this):

```bash
cp .env.example .env
#  then edit .env — set DISCORD_TOKEN, DISCORD_CLIENT_ID, ALLOWED_GUILD_IDS
```

Then pick a launch method.

> **Slash commands register automatically** when the bot starts (controlled by
> `AUTO_REGISTER_COMMANDS`, default `true`). With `ALLOWED_GUILD_IDS` (or
> `DEV_GUILD_ID`) set, they appear **instantly** in those servers; with neither,
> they register globally (first sync can take up to ~1h). No manual deploy step
> is needed — `npm run deploy-commands` / `DEPLOY_COMMANDS=true` remain available
> as an optional fallback.

### Method 1 — `start-bot.sh` (bare metal)

A single script that installs dependencies, generates the Prisma client,
creates/updates the SQLite database, optionally registers slash commands, then
starts the bot.

```bash
./start-bot.sh --deploy     # first run: also registers the /moderation command
./start-bot.sh              # subsequent runs (build + start, production)
./start-bot.sh --dev        # watch/auto-reload mode
./start-bot.sh --help       # all options
```

### Method 2 — Docker Compose

Builds an image, persists the database (`./data`) and model cache (`./models`)
in volumes, and restarts automatically.

```bash
# First run: build, apply schema, register slash commands, start (detached)
DEPLOY_COMMANDS=true docker compose up -d --build

# Normal start / restart
docker compose up -d

# Logs / stop
docker compose logs -f
docker compose down
```

`DEPLOY_COMMANDS=true` registers the `/moderation` command on startup — set it
only when you add or change commands (Discord keeps them registered otherwise).
The Compose file caps memory at 1.5 GB and mounts `./data` and `./models`.

### Method 3 — Manual npm scripts

```bash
npm install
npm run prisma:push        # creates ./data/moderation.db
npm run prisma:generate
npm run deploy-commands     # set DEV_GUILD_ID in .env for instant guild-scoped registration
npm run build && npm start  # or: npm run dev
```

> The first run downloads the model weights into `./models` (configurable via
> `TRANSFORMERS_CACHE`). This needs outbound access to `huggingface.co` once;
> afterwards it runs from cache. If the download is unavailable, the bot starts
> in lexicon-only mode automatically. Building the Docker image also fetches the
> native `onnxruntime`/`sharp` binaries, so the build host needs outbound HTTPS.

---

## Usage

In your server (as the **server owner** — all commands are owner-only):

```
/moderation setup rules-channel:#rules log-channel:#mod-log enabled:true
/moderation sync-rules          # parse the rules channel into rules
/moderation rules list          # review parsed rules and their IDs
/moderation status              # models, memory, rule count, last sync
```

Write your rules in the rules channel in any format — numbered lists, bullets,
emoji, markdown headers. Examples the parser understands:

```
1. Запрещены слова: "хуесос", "петух" → мут на 1 час
2. Нельзя оскорблять других участников = бан
3. No racism or hate speech. Punishment: ban
🚫 Spam and flooding are not allowed — warn
```

For each rule the parser extracts the **raw text** (for semantic matching),
**explicit keywords** (anything in quotes, or listed after `слова:` / `words:`),
and the **punishment** + duration if stated (`→ мут на 1 час`, `= бан`,
`Punishment: ban`, `предупреждение`). If it can't confidently structure a rule,
it's still stored as a "general" rule and participates via its embedding.

Auto-parsing is never perfect, so you can always fix a rule by hand — this is a
first-class feature:

```
/moderation rules edit <id>     # modal: keywords / punishment / duration / similarity
/moderation rules remove <id>
```

### All commands

| Command | Purpose |
|---|---|
| `/moderation setup` | Log channel, rules channel, enable/disable |
| `/moderation set-rules-channel #channel` | Set the rules source channel |
| `/moderation sync-rules` | Re-scan the rules channel |
| `/moderation rules list` | List parsed rules with IDs |
| `/moderation rules edit <id>` | Edit keywords / punishment / similarity (modal) |
| `/moderation rules remove <id>` | Delete a parsed rule |
| `/moderation default-action set` | Behaviour on high toxicity with no rule match (`ignore`/`warn`/`delete`) + toxicity threshold |
| `/moderation escalation set` | Ladder: at N warnings → mute/kick/ban |
| `/moderation escalation list` / `remove` | Manage the ladder |
| `/moderation whitelist add-role` / `add-channel` | Exempt roles / channels (also `remove-*`, `list`) |
| `/moderation logs [user] [limit]` | Recent moderation actions |
| `/moderation status` | Models, memory, rules, last sync |

Owners, admins, `Manage Server` holders, bots, and whitelisted roles/channels
are always exempt, and the rules channel and log channel are never moderated.

### Manual moderation commands

Alongside the automatic rule-based moderation, the mod team gets direct
commands. Each is gated by the matching Discord permission (the guild owner
always passes), shares the same warning/escalation/audit-log system, and posts
to the configured log channel.

| Command | Permission | Purpose |
|---|---|---|
| `/warn <user> <reason>` | Moderate Members | Warn a member (runs the escalation ladder) |
| `/warnings <user>` | Moderate Members | Show a member's active warnings |
| `/clearwarnings <user>` | Moderate Members | Clear a member's active warnings |
| `/timeout <user> <duration> [reason]` | Moderate Members | Mute for a duration (`30m`, `1h`, `1d`, `45s`, `1w`; bare number = minutes) |
| `/untimeout <user> [reason]` | Moderate Members | Remove a timeout |
| `/kick <user> [reason]` | Kick Members | Kick a member |
| `/ban <user> [reason] [delete-days]` | Ban Members | Ban a member (optionally delete 0–7 days of messages) |
| `/unban <user-id> [reason]` | Ban Members | Unban by user ID |
| `/purge <amount> [user]` | Manage Messages | Bulk-delete up to 100 recent messages (optionally from one user) |
| `/rules` | anyone | Show this server's parsed rules |

All commands register automatically on startup (see the note under **Setup**).
To force a re-sync you can still run `npm run deploy-commands` (or
`DEPLOY_COMMANDS=true docker compose up`).

---

## Project layout

```
src/
  index.ts               Client bootstrap, intents, graceful shutdown
  deployCommands.ts      Registers all slash commands (guild or global)
  config.ts              Typed env parsing + allow-list gate
  db.ts                  Prisma client + per-guild config helper
  ai/
    modelManager.ts      Lazy, best-effort model loading + status
    toxicity.ts          ML classifier + lexicon → combined score
    embeddings.ts        Sentence embeddings + cosine similarity
    lexicon.ts           RU+EN roots, keyword matcher, obfuscation handling
  rules/
    parser.ts            Free-form messages → structured rules
    ruleService.ts       Sync/CRUD, embedding storage, hot cache
  moderation/
    checker.ts           The 3-stage decision pipeline
    punishment.ts        Auto-moderation: delete/warn + escalation + logging
    actions.ts           Shared timeout/kick/ban/log helpers + duration parsing
    escalation.ts        Warning-count ladder
  commands/
    moderationCommand.ts /moderation SlashCommandBuilder definition
    handlers.ts          /moderation subcommand + modal handlers
    modCommands.ts       Manual command builders (warn/ban/timeout/…)
    modHandlers.ts       Manual command handlers
    register.ts          Auto-registers slash commands (guild-scoped or global)
  events/                ready / messageCreate / interactionCreate / guildCreate
  util/                  text normalization, permission checks
prisma/schema.prisma     SQLite schema (rules, warnings, logs, whitelist, …)
```

## Configuration reference

Copy `.env.example` to `.env` and fill in the values below. The most important
ones:

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` — credentials (**required**)
- `ALLOWED_GUILD_IDS` — comma-separated guilds the bot may moderate (empty =
  every guild)
- `DEV_GUILD_ID` — register slash commands to one guild for instant updates
  (empty = global registration)
- `DATABASE_URL` — SQLite location (default `file:./data/moderation.db`)
- `ENABLE_TOXICITY_MODEL`, `TOXICITY_MODEL` — ML toxicity model toggle/name
- `ENABLE_EMBEDDINGS`, `EMBEDDING_MODEL` — semantic matching toggle/name
- `USE_QUANTIZED_MODELS` — use int8 weights (recommended; smaller RAM)
- `TRANSFORMERS_CACHE` — where model weights are cached (default `./models`)
- `DEFAULT_SIMILARITY_THRESHOLD`, `DEFAULT_TOXICITY_THRESHOLD` — starting
  thresholds for new guilds (tunable per-guild and per-rule afterwards)
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## License

GPL-3.0 (see `LICENSE`).
