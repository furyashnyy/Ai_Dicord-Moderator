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

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    then edit .env — set DISCORD_TOKEN, DISCORD_CLIENT_ID, ALLOWED_GUILD_IDS

# 3. Create the SQLite database + Prisma client
npm run prisma:push        # runs `prisma db push` (creates ./data/moderation.db)
npm run prisma:generate

# 4. Register the /moderation slash command
#    (set DEV_GUILD_ID in .env for instant, guild-scoped registration)
npm run deploy-commands

# 5a. Development (auto-reload)
npm run dev

# 5b. Production
npm run build
npm start
```

> The first run downloads the model weights into `./models` (configurable via
> `TRANSFORMERS_CACHE`). This needs outbound access to `huggingface.co` once;
> afterwards it runs from cache. If the download is unavailable, the bot starts
> in lexicon-only mode automatically.

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

---

## Project layout

```
src/
  index.ts               Client bootstrap, intents, graceful shutdown
  deployCommands.ts      Registers /moderation (guild or global)
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
    punishment.ts        Delete/warn/mute/kick/ban + escalation + logging
    escalation.ts        Warning-count ladder
  commands/
    moderationCommand.ts SlashCommandBuilder definition
    handlers.ts          Subcommand + modal handlers
  events/                ready / messageCreate / interactionCreate
  util/                  text normalization, permission checks
prisma/schema.prisma     SQLite schema (rules, warnings, logs, whitelist, …)
```

## Configuration reference

See `.env.example` for every variable with inline documentation. The most
important ones:

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` — credentials (required)
- `ALLOWED_GUILD_IDS` — comma-separated guilds the bot may moderate
- `ENABLE_TOXICITY_MODEL`, `TOXICITY_MODEL` — ML toxicity model toggle/name
- `ENABLE_EMBEDDINGS`, `EMBEDDING_MODEL` — semantic matching toggle/name
- `DEFAULT_SIMILARITY_THRESHOLD`, `DEFAULT_TOXICITY_THRESHOLD` — starting
  thresholds for new guilds (tunable per-guild and per-rule afterwards)

## License

GPL-3.0 (see `LICENSE`).
