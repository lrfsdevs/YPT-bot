-- Adds the isLeave column to study_logs_v2 so prisma/schema.prisma matches the push-managed prod DB.
-- The column already exists in production; IF NOT EXISTS makes this a no-op there.
-- DB apply step is recorded in HANDOFF.md (2026-10-11 — CI schema-migration guard).
ALTER TABLE "study_logs_v2" ADD COLUMN IF NOT EXISTS "isLeave" boolean NOT NULL DEFAULT false;
