import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { moderationCommand } from './commands/moderationCommand.js';

/**
 * Registers slash commands with Discord.
 *  - If DEV_GUILD_ID is set, registers to that guild only (updates instantly).
 *  - Otherwise registers globally (can take up to ~1h to propagate).
 */
async function main(): Promise<void> {
  const commands = [moderationCommand];
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), {
      body: commands,
    });
    logger.info(`Registered ${commands.length} command(s) to dev guild ${config.devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    logger.info(`Registered ${commands.length} command(s) globally.`);
  }
}

main().catch((err) => {
  logger.error('Failed to deploy commands:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
