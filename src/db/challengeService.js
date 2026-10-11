import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Dynamically resolves the active challenge from the database using strict UTC time.
 * @param {Date} [nowUtc=new Date()]
 * @returns {Promise<object|null>}
 */
export async function getActiveChallenge(nowUtc = new Date()) {
  const now = new Date(nowUtc);

  // 1. Check if an explicit challenge ID was provided in environment
  if (env.ACTIVE_CHALLENGE_ID) {
    const explicit = await prisma.challenge.findUnique({
      where: { id: env.ACTIVE_CHALLENGE_ID },
    });
    if (explicit) {
      return explicit;
    }
    logger.warn('Configured ACTIVE_CHALLENGE_ID not found. Falling back to dynamic query.', { activeChallengeId: env.ACTIVE_CHALLENGE_ID });
  }

  // 2. Query the active challenge strictly in UTC time: startAt <= now <= endAt
  const active = await prisma.challenge.findFirst({
    where: {
      startAt: { lte: now },
      endAt: { gte: now },
    },
    orderBy: { startAt: 'desc' },
  });

  if (active) {
    return active;
  }

  // 3. Fallback: If no challenge is currently running, find the most recently ended challenge
  const latest = await prisma.challenge.findFirst({
    orderBy: { endAt: 'desc' },
  });

  if (latest) {
    logger.warn('No challenge currently active. Using the latest challenge instead.', { nowUtc: now.toISOString(), challengeId: latest.id, challengeTitle: latest.title });
    return latest;
  }

  return null;
}

/**
 * Builds an in-memory lookup map of YPT User ID -> ChallengeParticipant
 * @param {string} challengeId 
 * @returns {Promise<Map<string, { participantId: string, userId: string, yptId: string, displayName: string, username: string }>>}
 */
export async function getParticipantMap(challengeId) {
  if (!challengeId) return new Map();

  const participants = await prisma.challengeParticipant.findMany({
    where: { challengeId },
    include: {
      user: {
        select: {
          id: true,
          yptId: true,
          username: true,
          displayName: true,
        },
      },
    },
  });

  const map = new Map();

  for (const p of participants) {
    const yptId = p.user?.yptId ? String(p.user.yptId).trim() : null;
    if (yptId) {
      map.set(yptId, {
        participantId: p.id,
        userId: p.userId,
        yptId,
        username: p.user.username || '',
        displayName: p.user.displayName || p.user.username || 'Participant',
      });
    }
  }

  return map;
}
