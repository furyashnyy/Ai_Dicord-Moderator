import { PermissionFlagsBits, type GuildMember, type Interaction } from 'discord.js';
import { prisma } from '../db.js';

/**
 * All privileged slash commands require the interaction to come from the guild
 * OWNER, per the task spec: `interaction.guild.ownerId === interaction.user.id`.
 */
export function isGuildOwner(interaction: Interaction): boolean {
  if (!interaction.guild) return false;
  return interaction.guild.ownerId === interaction.user.id;
}

/**
 * Whether a member should be exempt from moderation: guild owner, admins,
 * bots, and members with a whitelisted role. Channel whitelisting is checked
 * separately (needs the channel id).
 */
export async function isExemptMember(guildId: string, member: GuildMember): Promise<boolean> {
  if (member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  const roles = await prisma.whitelistRole.findMany({ where: { guildId } });
  if (roles.length > 0) {
    const roleIds = new Set(roles.map((r) => r.roleId));
    for (const roleId of member.roles.cache.keys()) {
      if (roleIds.has(roleId)) return true;
    }
  }
  return false;
}

export async function isWhitelistedChannel(guildId: string, channelId: string): Promise<boolean> {
  const row = await prisma.whitelistChannel.findUnique({
    where: { guildId_channelId: { guildId, channelId } },
  });
  return row !== null;
}
