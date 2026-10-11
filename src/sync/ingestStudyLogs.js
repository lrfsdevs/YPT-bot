import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { clampDailyStudySeconds, cappedLiveStudyMs, MAX_DAILY_STUDY_SECONDS, MAX_CONTINUOUS_SESSION_MS } from '../config/limits.js';
import { getActiveChallenge, getParticipantMap } from '../db/challengeService.js';
import { signIn, splashLogin, getAggregatedMembers } from '../yptService.js';
import { logger } from '../logger.js';

/**
 * Normalizes any timestamp to a strict UTC midnight Date object (00:00:00.000Z)
 * @param {Date|string|number} [nowUtc=new Date()]
 * @returns {Date}
 */
export function computeUtcLogDate(nowUtc = new Date()) {
  const d = new Date(nowUtc);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export const CHALLENGE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Computes the challenge-anchored day bucket for a UTC instant.
 * Day N spans [startAt + N*24h, startAt + (N+1)*24h); the returned Date is the
 * UTC midnight of that bucket's calendar date (matching the @db.Date column).
 * @param {Date|string|number} [nowUtc=new Date()]
 * @param {Date|string|number} challengeStartAt
 * @returns {Date}
 */
export function computeChallengeDayLogDate(nowUtc = new Date(), challengeStartAt) {
  const now = new Date(nowUtc).getTime();
  const start = new Date(challengeStartAt).getTime();
  const dayIndex = Math.max(0, Math.floor((now - start) / CHALLENGE_DAY_MS));
  const bucketStart = new Date(start + dayIndex * CHALLENGE_DAY_MS);
  return new Date(Date.UTC(
    bucketStart.getUTCFullYear(), bucketStart.getUTCMonth(), bucketStart.getUTCDate()
  ));
}

/**
 * Derives a human-readable status string from member telemetry
 * @param {object} member 
 * @returns {string}
 */
export function deriveStudyStatus(member) {
  if (member.isStudying) {
    return 'STUDYING';
  }
  return 'OFFLINE';
}

/**
 * Ingests scraped YPT members into DailyStudyLogV2 (study_logs_v2)
 * for the currently active challenge in UTC time.
 * 
 * Performance Optimized: Pre-fetches existing daily logs in a single query
 * and performs concurrent upserts to eliminate N+1 latency.
 * 
 * @param {string|number} groupId 
 * @param {Array<object>} members 
 * @param {Date} [nowUtc=new Date()]
 * @param {import('winston').Logger} [log=logger]
 * @returns {Promise<object>}
 */
export async function ingestGroupMembersToDailyStudyLogs(groupId, members, nowUtc = new Date(), log = logger) {
  const startTime = Date.now();

  // 1. Resolve Active Challenge in UTC
  const challenge = await getActiveChallenge(nowUtc);
  if (!challenge) {
    log.warn('No challenge is active in database. Ingestion skipped.');
    return {
      success: false,
      reason: 'NO_ACTIVE_CHALLENGE',
      matchedCount: 0,
      upsertedCount: 0,
    };
  }

  // Challenge-anchored day bucket (derived from challenge start in UTC)
  const logDate = computeChallengeDayLogDate(nowUtc, challenge.startAt);

  // 2. Resolve in-memory participant lookup table (yptId -> participantId)
  const participantMap = await getParticipantMap(challenge.id);

  // 3. Pre-fetch existing logs for today in a single query to eliminate N+1 roundtrips
  const participantIds = Array.from(participantMap.values()).map((p) => p.participantId);
  const existingRecords = await prisma.dailyStudyLogV2.findMany({
    where: {
      logDate,
      participantId: { in: participantIds },
    },
    select: {
      id: true,
      participantId: true,
      isOverride: true,
    },
  });
  const existingMap = new Map(existingRecords.map((r) => [r.participantId, r]));

  let matchedCount = 0;
  let unlinkedCount = 0;
  let skippedOverrides = 0;
  let cappedCount = 0;
  let sessionCappedCount = 0;
  let upsertedCount = 0;

  const upsertOperations = [];

  for (const member of members) {
    const yptId = String(member.userId || member.ud || member.id || '').trim();
    if (!yptId) continue;

    const participant = participantMap.get(yptId);

    // If member has not linked their YPT ID to a participant in this challenge
    if (!participant) {
      unlinkedCount++;
      continue;
    }

    matchedCount++;

    // Calculate real-time integer seconds using liveStudyMs to capture ongoing active timer elapsed time
    // Continuous sessions are capped at 4h before the daily 14h clamp is applied.
    const cappedLiveMs = cappedLiveStudyMs(member.todayStudyMs, member.sessionElapsedMs);
    const studyMs = Math.max(
      cappedLiveMs,
      Number(member.todayStudyMs || 0),
      Number(member.studyMs || 0)
    );
    const rawSeconds = Math.floor(studyMs / 1000);
    const durationSeconds = clampDailyStudySeconds(rawSeconds);
    if (rawSeconds > MAX_DAILY_STUDY_SECONDS) cappedCount++;
    if (Number(member.sessionElapsedMs || 0) > MAX_CONTINUOUS_SESSION_MS) sessionCappedCount++;
    const status = deriveStudyStatus(member);

    // 4. Admin Override Safety (Law L5)
    // Check if an existing row has isOverride: true. If so, do not overwrite durationSeconds.
    const existing = existingMap.get(participant.participantId);

    if (existing?.isOverride) {
      skippedOverrides++;
      // Still update live status without touching durationSeconds
      upsertOperations.push(
        prisma.dailyStudyLogV2.update({
          where: { id: existing.id },
          data: { status },
        })
      );
      continue;
    }

    // 5. Upsert DailyStudyLogV2
    upsertOperations.push(
      prisma.dailyStudyLogV2.upsert({
        where: {
          participantId_logDate: {
            participantId: participant.participantId,
            logDate,
          },
        },
        create: {
          participantId: participant.participantId,
          logDate,
          durationSeconds,
          status,
          isOverride: false,
        },
        update: {
          durationSeconds,
          status,
        },
      })
    );

    upsertedCount++;
  }

  // Execute all upserts concurrently
  await Promise.all(upsertOperations);

  const durationMs = Date.now() - startTime;
  log.info('Ingest complete', {
    challengeId: challenge.id,
    challengeTitle: challenge.title,
    logDate: logDate.toISOString().slice(0, 10),
    matchedCount,
    upsertedCount,
    skippedOverrides,
    cappedCount,
    sessionCappedCount,
    unlinkedCount,
    durationMs,
  });

  return {
    success: true,
    challengeId: challenge.id,
    challengeTitle: challenge.title,
    logDate,
    matchedCount,
    unlinkedCount,
    skippedOverrides,
    cappedCount,
    sessionCappedCount,
    upsertedCount,
    durationMs,
  };
}

/**
 * Executes a single ingestion iteration across all configured YPT groups.
 * Uses multi-group aggregation to deduplicate members and handle errors gracefully.
 */
export async function runIngest() {
  const start = Date.now();
  const run = logger.child({ runId: randomUUID(), trigger: 'runIngest' });
  run.info('Running YPT study logs ingestion...');

  if (!env.YPT_EMAIL || !env.YPT_PASSWORD) {
    throw new Error('YPT_EMAIL and YPT_PASSWORD must be configured in .env');
  }

  const groupIds = env.YPT_GROUP_IDS;
  if (!groupIds || groupIds.length === 0) {
    throw new Error('YPT_GROUP_IDS must be configured in .env');
  }

  const auth = await signIn(env.YPT_EMAIL, env.YPT_PASSWORD);
  await splashLogin(auth.token);

  const groups = groupIds.map((id) => ({ id, name: `Group ${id}` }));
  const aggregated = await getAggregatedMembers(auth.token, groups);

  run.info('Fetched aggregated members.', {
    members: aggregated.members.length,
    successfulGroups: aggregated.successfulGroups,
    groups: groups.length,
  });
  const result = await ingestGroupMembersToDailyStudyLogs('aggregated', aggregated.members, new Date(), run);

  run.info('Ingestion cycle completed.', { durationMs: Date.now() - start });
  return result;
}

// Auto-run when executed directly via CLI
const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const args = process.argv.slice(2);
  const loopArgIndex = args.findIndex((a) => a === '--loop' || a === '--interval');
  const intervalMinutes = loopArgIndex !== -1 ? parseInt(args[loopArgIndex + 1], 10) || 5 : 0;

  if (intervalMinutes > 0) {
    logger.info('Ingest daemon started.', { intervalMinutes });

    // If deployed on Render Web Service (which requires an open HTTP port)
    if (process.env.PORT) {
      import('node:http').then(({ createServer }) => {
        const port = Number(process.env.PORT) || 3000;
        const server = createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'ingest-watch', intervalMinutes }));
        });
        server.listen(port, '0.0.0.0', () => {
          logger.info('Health server listening (Render compatible).', { host: '0.0.0.0', port });
        });
      });
    }

    runIngest().catch((e) => logger.error('Ingest error', e));
    setInterval(() => {
      runIngest().catch((e) => logger.error('Ingest error', e));
    }, intervalMinutes * 60 * 1000);
  } else {
    runIngest()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('Fatal error in runIngest', err);
        process.exit(1);
      });
  }
}
