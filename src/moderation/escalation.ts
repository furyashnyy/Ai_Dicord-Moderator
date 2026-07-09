import { prisma } from '../db.js';
import type { PunishmentType } from '../rules/parser.js';

export interface EscalationOutcome {
  action: PunishmentType;
  duration: number | null;
  threshold: number;
}

/** Count a member's currently active warnings in a guild. */
export async function activeWarningCount(guildId: string, userId: string): Promise<number> {
  return prisma.warning.count({ where: { guildId, userId, active: true } });
}

/**
 * Given a member's active-warning count, return the highest escalation step
 * whose threshold has been reached, or null if none apply.
 */
export async function resolveEscalation(
  guildId: string,
  warningCount: number,
): Promise<EscalationOutcome | null> {
  if (warningCount <= 0) return null;
  const step = await prisma.escalationStep.findFirst({
    where: { guildId, threshold: { lte: warningCount } },
    orderBy: { threshold: 'desc' },
  });
  if (!step) return null;
  return {
    action: step.action as PunishmentType,
    duration: step.duration,
    threshold: step.threshold,
  };
}
