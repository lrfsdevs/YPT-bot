import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve project root .env regardless of working directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');

dotenv.config({ path: envPath });

/**
 * Helper to parse comma-separated string into string array
 * @param {string} val 
 * @returns {string[]}
 */
function parseArray(val) {
  if (!val) return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Helper to parse integer with fallback
 * @param {string} val 
 * @param {number} fallback 
 * @returns {number}
 */
function parseIntFallback(val, fallback) {
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Centralized Single Point of Contact (SPOC) for all environment configuration
 */
export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Logging
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  LOG_SILENT: String(process.env.LOG_SILENT || '').toLowerCase() === 'true',
  
  // Database (PostgreSQL - Supabase / Local)
  DATABASE_URL: process.env.DATABASE_URL || '',
  DIRECT_URL: process.env.DIRECT_URL || '',

  // YPT Credentials
  YPT_EMAIL: (process.env.YPT_EMAIL || '').trim(),
  YPT_PASSWORD: (process.env.YPT_PASSWORD || '').trim(),

  // Monitored YPT Group IDs
  YPT_GROUP_IDS: parseArray(process.env.YPT_GROUP_IDS),

  // Operational Express Server
  PORT: parseIntFallback(process.env.PORT, 3000),
  API_SECRET: process.env.API_SECRET || 'ypt-internal-secret',

  // Adaptive Polling Schedules (seconds)
  POLL_INTERVAL_ACTIVE_SEC: parseIntFallback(process.env.POLL_INTERVAL_ACTIVE_SEC, 45),
  POLL_INTERVAL_IDLE_SEC: parseIntFallback(process.env.POLL_INTERVAL_IDLE_SEC, 300),

  // Stale Studier Timeout (minutes)
  STALE_STUDY_TIMEOUT_MINUTES: parseIntFallback(process.env.STALE_STUDY_TIMEOUT_MINUTES, 120),

  // Timezone & Day Rollover
  TIMEZONE: process.env.TIMEZONE || 'Asia/Kolkata',
  DAY_ROLLOVER_HOUR: parseIntFallback(process.env.DAY_ROLLOVER_HOUR, 5),

  // Health Alerting (Discord)
  DISCORD_WEBHOOK_URL: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
  ALERT_FAILURE_THRESHOLD: parseIntFallback(process.env.ALERT_FAILURE_THRESHOLD, 5),

  // Optional manual Challenge ID override (defaults to dynamic UTC DB lookup)
  ACTIVE_CHALLENGE_ID: process.env.ACTIVE_CHALLENGE_ID ? process.env.ACTIVE_CHALLENGE_ID.trim() : null,
});

export default env;
