import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

export const prisma = new PrismaClient();

/**
 * Fetch (creating if necessary) the configuration row for a guild.
 * Defaults for the thresholds come from the environment so a fresh guild
 * starts with sane, operator-defined values.
 */
export async function getGuildConfig(guildId: string) {
  const existing = await prisma.guildConfig.findUnique({ where: { id: guildId } });
  if (existing) return existing;
  const { config } = await import('./config.js');
  logger.info(`Creating default config for guild ${guildId}`);
  return prisma.guildConfig.create({
    data: {
      id: guildId,
      similarityThreshold: config.defaultSimilarityThreshold,
      toxicityThreshold: config.defaultToxicityThreshold,
    },
  });
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
