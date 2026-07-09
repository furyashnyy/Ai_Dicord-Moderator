import { Events, type Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { warmupModels } from '../ai/modelManager.js';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  logger.info(`Logged in as ${client.user.tag} (${client.user.id}).`);
  logger.info(`Serving ${client.guilds.cache.size} guild(s).`);

  if (config.allowedGuildIds.length === 0) {
    logger.warn('ALLOWED_GUILD_IDS is empty — the bot will moderate EVERY guild it is in.');
  } else {
    logger.info(`Moderating allowed guilds: ${config.allowedGuildIds.join(', ')}`);
  }

  // Warm up AI models in the background so the first message isn't slow.
  // Failures degrade gracefully to the lexicon-only path.
  warmupModels().catch((err) =>
    logger.warn('Model warmup encountered an error:', err instanceof Error ? err.message : err),
  );
}
