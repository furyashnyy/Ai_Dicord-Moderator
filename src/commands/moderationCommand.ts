import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

/**
 * Builder for the single top-level `/moderation` command and all of its
 * subcommands / subcommand groups.
 */
export const moderationCommand = new SlashCommandBuilder()
  .setName('moderation')
  .setDescription('Configure and control rule-based AI moderation')
  .setDMPermission(false)
  // Owner-only is enforced in code; this just hides it from non-managers by default.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  // /moderation setup
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Base setup: log channel, rules channel, enable/disable')
      .addChannelOption((o) =>
        o
          .setName('log-channel')
          .setDescription('Channel where moderation actions are logged')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o
          .setName('rules-channel')
          .setDescription('Channel that contains the server rules')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addBooleanOption((o) =>
        o.setName('enabled').setDescription('Enable or disable moderation on this server'),
      ),
  )

  // /moderation set-rules-channel
  .addSubcommand((sub) =>
    sub
      .setName('set-rules-channel')
      .setDescription('Set the channel the bot reads rules from')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The rules channel')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )

  // /moderation sync-rules
  .addSubcommand((sub) =>
    sub.setName('sync-rules').setDescription('Re-scan the rules channel and rebuild parsed rules'),
  )

  // /moderation status
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show models, memory, rule count and last sync'),
  )

  // /moderation logs
  .addSubcommand((sub) =>
    sub
      .setName('logs')
      .setDescription('Show recent moderation actions')
      .addUserOption((o) => o.setName('user').setDescription('Filter by user'))
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many entries (1-20)').setMinValue(1).setMaxValue(20),
      ),
  )

  // /moderation rules ...
  .addSubcommandGroup((group) =>
    group
      .setName('rules')
      .setDescription('Inspect and edit parsed rules')
      .addSubcommand((sub) => sub.setName('list').setDescription('List parsed rules with their IDs'))
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit keywords / punishment / similarity of a rule')
          .addIntegerOption((o) =>
            o.setName('id').setDescription('Rule ID (see /moderation rules list)').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Delete a parsed rule')
          .addIntegerOption((o) => o.setName('id').setDescription('Rule ID').setRequired(true)),
      ),
  )

  // /moderation default-action set
  .addSubcommandGroup((group) =>
    group
      .setName('default-action')
      .setDescription('Behaviour on high general toxicity with no specific rule match')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set the default action')
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('What to do')
              .setRequired(true)
              .addChoices(
                { name: 'ignore (do nothing)', value: 'ignore' },
                { name: 'warn (delete + warn)', value: 'warn' },
                { name: 'delete (remove message only)', value: 'delete' },
              ),
          )
          .addNumberOption((o) =>
            o
              .setName('toxicity-threshold')
              .setDescription('Toxicity score 0..1 required to trigger (default 0.8)')
              .setMinValue(0)
              .setMaxValue(1),
          ),
      ),
  )

  // /moderation escalation ...
  .addSubcommandGroup((group) =>
    group
      .setName('escalation')
      .setDescription('Escalation ladder based on number of warnings')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Add or update an escalation step')
          .addIntegerOption((o) =>
            o.setName('warnings').setDescription('Warning count that triggers this step').setRequired(true).setMinValue(1),
          )
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('Action at this threshold')
              .setRequired(true)
              .addChoices(
                { name: 'mute (timeout)', value: 'mute' },
                { name: 'kick', value: 'kick' },
                { name: 'ban', value: 'ban' },
              ),
          )
          .addIntegerOption((o) =>
            o.setName('duration-seconds').setDescription('Mute duration in seconds').setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove an escalation step')
          .addIntegerOption((o) =>
            o.setName('warnings').setDescription('Threshold to remove').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show the escalation ladder')),
  )

  // /moderation whitelist ...
  .addSubcommandGroup((group) =>
    group
      .setName('whitelist')
      .setDescription('Exempt roles or channels from moderation')
      .addSubcommand((sub) =>
        sub
          .setName('add-role')
          .setDescription('Exempt a role')
          .addRoleOption((o) => o.setName('role').setDescription('Role to exempt').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('add-channel')
          .setDescription('Exempt a channel')
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Channel to exempt').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove-role')
          .setDescription('Remove a role exemption')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove-channel')
          .setDescription('Remove a channel exemption')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List whitelisted roles and channels')),
  )
  .toJSON();
