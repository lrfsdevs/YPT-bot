-- Add status to DailyStudyLog (YPT ingest moves from DailyStudyLogV2 → DailyStudyLog)
-- Table name verified against schema.prisma:
--   DailyStudyLog → no @@map → table "DailyStudyLog"
--   DailyStudyLogV2 → @@map("study_logs_v2") already has status VARCHAR(32)
-- IF NOT EXISTS keeps this idempotent across environments and fresh databases.
ALTER TABLE "DailyStudyLog" ADD COLUMN IF NOT EXISTS "status" VARCHAR(32);
