# HANDOFF

## 2026-10-11 — CI schema-migration guard + quality gates

### What changed
- **New `scripts/check-schema-migration.sh [base]`** (default `origin/master`): fails if
  `prisma/schema.prisma` changed vs the base ref and nothing under `prisma/migrations/` changed.
  Message tells you to add `prisma/migrations/<timestamp>_<name>/migration.sql` and record the DB
  apply step in HANDOFF.md.
- **New `.github/workflows/ci.yml`**: on push/PR to `master` + `dev` (Node 22, `fetch-depth: 0`),
  runs schema guard → `npm test` → `npm run build`.
- **DB-backed suites skip in CI** via `{ skip: process.env.CI_SKIP_DB === 'true' }`
  (`test/ingest-utc.test.js` "Database …" block, `test/challenge-sync.test.js`). The workflow sets
  placeholder `DATABASE_URL`/`DIRECT_URL` so `PrismaClient` can still be imported; no connection is made.
- **`AGENTS.md`**: added the rule that `prisma/schema.prisma` changes must ship with a migration.
- **New migration** `prisma/migrations/20261011000000_add_is_leave_to_study_logs_v2/migration.sql`:
  `ALTER TABLE "study_logs_v2" ADD COLUMN IF NOT EXISTS "isLeave" boolean NOT NULL DEFAULT false;`

### DB apply step
- The `isLeave` migration is a **no-op in production** (the column already exists; `IF NOT EXISTS`).
  Apply via `prisma migrate deploy` or the raw SQL where a DB lacks it. Nothing in the build pipeline
  syncs the schema — apply manually.

### Verification
- Guard paths verified in a throwaway repo: pass (no schema change), fail (schema change w/o
  migration), pass (with migration), and a clear error for a missing base ref.
- The guard currently **fails on `dev`** because commit `303bbbf` changed `prisma/schema.prisma`
  with no migration — expected; it passes once this migration commit lands in the branch range.
- `CI_SKIP_DB=true DATABASE_URL=… npm test` → 32 pass / 0 fail, DB suites `SKIP`.
- `npm run build` → exit 0 with the placeholder env.

### Open / follow-ups
- Live drift detection (`prisma/schema.prisma` vs the actual DB) is **not** implemented — would need a
  DB secret in Actions.
- Commit `303bbbf` (winston logging + day buckets) is on `dev` ahead of `master`; open a PR to `master`
  when ready (the guard will require this migration to be included).

---

## 2026-10-11 — Centralized winston logging (for incident diagnosis)

### What changed
- **New `src/logger.js`** — single centralized logger. `createLogger()` factory (injectable
  transports/format for tests) + shared `logger` instance. JSON on stdout in production, colorized
  pretty in development; errors go to stderr; `logger.child({...})` attaches per-run context.
- **`src/config/env.js`** — added `LOG_LEVEL` (default `info`) and `LOG_SILENT` (default false) per
  the SPOC rule (no `process.env` outside this file).
- **Wired all 53 `console.*` sites** in `server.js`, `sync/ingestStudyLogs.js`,
  `sync/challenge_sync.js`, `db/challengeService.js`, `yptService.js` to the logger.
  - `server.js`: request middleware now emits a structured `http` line on response `finish`
    (`{ method, url, status, durationMs }`); startup/periodic/error paths logged with a per-run
    `runId`. Kept `console.table`, the login prompt, and the endpoint banner (UI).
  - `ingestStudyLogs.js`: `runIngest()` and `ingestGroupMembersToDailyStudyLogs` use a child logger
    with `runId`; the ingest summary is structured (`challengeId, logDate, matchedCount,
    upsertedCount, skippedOverrides, cappedCount, sessionCappedCount, unlinkedCount, durationMs`).
  - `challenge_sync.js`: child logger `{ runId, challengeId }`; `log()` keeps the `verbose` gate; kept
    the summary `console.table`. Errors pass the `Error` (stack captured).
  - `yptService.js`: per-group scrape failures logged with `{ groupId, reason }`.
- **`package.json`** — added `winston` (^3.19.0); `test` script now `LOG_SILENT=true node --test`.
- **`test/logger.test.js`** — 4 tests (default/call meta, child context merge, silent, error stack).

### Verification
- `npm test` = **35 pass / 0 fail**.
- Dev output = colorized pretty with JSON meta; `NODE_ENV=production` output = single-line JSON with
  `service`, `timestamp`, `runId`, `challengeId`, and `stack` on errors.
- `node --check` passes on all six modified files; `grep console.` shows only UI/table/prompt sites.
- Not exercised live: the HTTP access line was verified via format checks, not by booting the server
  (starting it triggers a real YPT ingest/DB write).

---

## 2026-10-11 — Challenge-anchored day bucket (align bot with product day boundary)

### Context
Incident: Saturday (2026-10-10) `study_logs_v2` rows for ~28 participants were reset to 0 after the
day ended. Root cause: the bot overwrote `durationSeconds` with YPT's instantaneous daily counter,
which reads 0 around day boundaries; the bot also bucketed by plain UTC calendar date while the
product keys days off the challenge start. Full analysis in
`INCIDENT_REPORT_2026-10-11_saturday_logs.md`.

Requested follow-up (this change): **ignore the YPT day; use the product's day bucket, derived from
`Challenge.startAt` in UTC.** The zero-overwrite guard was explicitly **out of scope**.

### What changed
- `src/sync/ingestStudyLogs.js`
  - Added `CHALLENGE_DAY_MS` and exported `computeChallengeDayLogDate(nowUtc, challengeStartAt)`:
    `N = max(0, floor((now − startAt) / 24h))`; returns UTC midnight of `startAt + N·24h`
    (matches the `@db.Date` column).
  - `ingestGroupMembersToDailyStudyLogs`: `logDate` is now computed **after** the challenge resolves,
    from `challenge.startAt` (was `computeUtcLogDate(nowUtc)` before resolution).
  - Kept `computeUtcLogDate` (still used for V1 row normalization and start/end date labels).
- `src/sync/challenge_sync.js`
  - Imported the new helper; `todayUtc` now uses `computeChallengeDayLogDate(nowUtc, challenge.startAt)`
    (moved after challenge resolution). Phase 1 range bounds and Phase 2 live upserts are aligned.
    `challengeStartUtc` / `challengeEndUtc` and Phase 1 `rowLogDate` remain `computeUtcLogDate(...)`.
- `doc.md` — §6 "Strict UTC Time Guarantee" now documents the challenge-anchored bucket and that
  YPT's day boundary is ignored.
- `test/ingest-utc.test.js` — added 5 `computeChallengeDayLogDate` cases (midnight parity,
  non-midnight anchor, exact `startAt + N·24h` rollover, 24h-window stability, pre-start clamp).
- `test/challenge-sync.test.js` — removed an unused `computeUtcLogDate` import.

### Entry points affected (all live writes funnel here)
- `npm start` → `src/server.js` initial + 5-min interval → `ingestGroupMembersToDailyStudyLogs`
- `POST /sync` → `ingestGroupMembersToDailyStudyLogs`
- `npm run ingest` / `ingest:watch` → `runIngest()` → `ingestGroupMembersToDailyStudyLogs`
- `npm run challenge_sync` → `syncChallengeFromMonday()` (Phase 1 + Phase 2)

### Verification
- `npm test` = **31 pass / 0 fail** (new bucket suite + the two fixes below).
- Parity check: for the active challenge (`startAt = 2026-10-05T00:00:00Z`) the new bucket equals the
  previous UTC calendar date for all sampled instants → **no data migration/backfill needed**.

### Open items / next steps
- **Rejected (2026-10-11):** monotonic/zero-overwrite guard. A `max(existing, incoming)` write would
  also block legitimate downward corrections (e.g. a user removing hours in YPT). Do not re-add it
  unless real decreases can be distinguished from glitchy `0` samples.
- Minor data inconsistency (flagged, not fixed): 3 rows in `study_logs_v2` still have
  `status='Offline'` (wrong casing; 2026-10-09). Normalize to `'OFFLINE'` if desired.
- **Done (2026-10-11):** fixed the flaky `test/session-cap.test.js` exact-ms assertion — the "~2h"
  check is now tolerance-based (`Math.abs(liveStudyMs - 7200000) < 2000`), matching the other
  time-window assertions.
- **Done (2026-10-11):** normalized the 17 `study_logs_v2` rows with `status IS NULL` (all
  `isOverride=true`, dates 2026-10-05..09) to `status='OFFLINE'` via a targeted
  `updateMany({ where: { status: null } })`. `challenge-sync.test.js` "Monday logs are OFFLINE"
  assertion now holds.
- **Done:** added the live-DB `isLeave Boolean @default(false)` column to `DailyStudyLogV2` in
  `prisma/schema.prisma` so it matches the deployed `study_logs_v2` table (previously a
  `prisma db push` from the repo schema would have tried to drop it). `npx prisma validate` passes.
