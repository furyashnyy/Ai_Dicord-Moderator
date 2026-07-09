import { REST, Routes, type Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { moderationCommand } from './moderationCommand.js';
import { modCommands } from './modCommands.js';

/** The full set of slash commands the bot exposes (config + manual). */
export function allCommands() {
  return [moderationCommand, ...modCommands];
}

function rest(): REST {
  return new REST({ version: '10' }).setToken(config.discordToken);
}

/**
 * Whether we register commands per-guild (instant) rather than globally.
 * Guild-scoped registration appears immediately, which is what a self-hosted
 * bot on a known set of servers wants. Global registration can take up to ~1h.
 */
function usesGuildScope(): boolean {
  return config.devGuildId !== '' || config.allowedGuildIds.length > 0;
}

/** Register the full command set to a single guild (instant availability). */
export async function registerCommandsForGuild(clientId: string, guildId: string): Promise<void> {
  const commands = allCommands();
  await rest().put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  logger.info(`Registered ${commands.length} slash command(s) to guild ${guildId}.`);
}

/**
 * Register slash commands on startup so they always exist in Discord without a
 * separate manual deploy step.
 *  - DEV_GUILD_ID set        → that guild only (instant).
 *  - ALLOWED_GUILD_IDS set   → each allowed guild (instant).
 *  - neither                 → global (works everywhere; first sync is slower).
 * Failures are logged, never fatal — the bot keeps running.
 */
export async function registerCommandsOnStartup(client: Client<true>): Promise<void> {
  const commands = allCommands();
  const clientId = client.user.id;
  try {
    if (config.devGuildId) {
      await registerCommandsForGuild(clientId, config.devGuildId);
      return;
    }
    if (config.allowedGuildIds.length > 0) {
      for (const guildId of config.allowedGuildIds) {
        try {
          await registerCommandsForGuild(clientId, guildId);
        } catch (err) {
          logger.warn(
            `Failed to register commands to guild ${guildId} (is the bot in it?):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      return;
    }
    await rest().put(Routes.applicationCommands(clientId), { body: commands });
    logger.info(
      `Registered ${commands.length} slash command(s) globally (can take up to ~1h to appear the first time).`,
    );
  } catch (err) {
    logger.error('Failed to register slash commands:', err instanceof Error ? err.stack ?? err.message : err);
  }
}

export { usesGuildScope };
