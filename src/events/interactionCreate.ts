import { Events, MessageFlags, type Interaction } from 'discord.js';
import { logger } from '../logger.js';
import { handleModerationCommand, handleRuleEditModal } from '../commands/handlers.js';
import { handleModCommand } from '../commands/modHandlers.js';
import { modCommandNames } from '../commands/modCommands.js';

export const name = Events.InteractionCreate;

export async function execute(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'moderation') {
        await handleModerationCommand(interaction);
      } else if (modCommandNames.has(interaction.commandName)) {
        await handleModCommand(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('rule-edit:')) {
        await handleRuleEditModal(interaction);
      }
      return;
    }
  } catch (err) {
    logger.error('Interaction handler error:', err instanceof Error ? err.stack ?? err.message : err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}
