import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  allowedGuildIds: list('ALLOWED_GUILD_IDS'),
  devGuildId: optional('DEV_GUILD_ID', ''),
  autoRegisterCommands: bool('AUTO_REGISTER_COMMANDS', true),

  databaseUrl: optional('DATABASE_URL', 'file:./data/moderation.db'),

  enableToxicityModel: bool('ENABLE_TOXICITY_MODEL', true),
  toxicityModel: optional('TOXICITY_MODEL', 'Xenova/toxic-bert'),
  enableEmbeddings: bool('ENABLE_EMBEDDINGS', true),
  embeddingModel: optional('EMBEDDING_MODEL', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
  useQuantizedModels: bool('USE_QUANTIZED_MODELS', true),
  transformersCache: optional('TRANSFORMERS_CACHE', './models'),

  defaultSimilarityThreshold: num('DEFAULT_SIMILARITY_THRESHOLD', 0.55),
  defaultToxicityThreshold: num('DEFAULT_TOXICITY_THRESHOLD', 0.8),

  logLevel: optional('LOG_LEVEL', 'info'),
} as const;

/** Whether the bot is allowed to moderate the given guild. */
export function isGuildAllowed(guildId: string): boolean {
  // Empty allow-list => every guild is allowed (a warning is logged at startup).
  if (config.allowedGuildIds.length === 0) return true;
  return config.allowedGuildIds.includes(guildId);
}
