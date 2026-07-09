import { Events, type Guild } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerCommandsForGuild, usesGuildScope } from '../commands/register.js';

export const name = Events.GuildCreate;

/**
 * When the bot joins a new guild, register the command set to that guild for
 * instant availability — but only when we use guild-scoped registration
 * (global registration already covers every guild).
 */
export async function execute(guild: Guild): Promise<void> {
  if (!config.autoRegisterCommands || !usesGuildScope()) return;
  try {
    await registerCommandsForGuild(guild.client.user.id, guild.id);
  } catch (err) {
    logger.warn(`Failed to register commands to new guild ${guild.id}:`, err instanceof Error ? err.message : err);
  }
}
