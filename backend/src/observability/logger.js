/**
 * Structured Logger
 *
 * Provides consistent, machine-parseable logging for the application.
 * Every log entry includes a timestamp, level, and structured context.
 *
 * Design Decision: Why not Winston/Pino?
 * - The assessment says to keep it proportional
 * - A custom logger with JSON output is sufficient for this scale
 * - It can be replaced with a production logger later without changing call sites
 * - Zero additional dependencies
 *
 * Log format (JSON per line):
 * {
 *   "timestamp": "2024-01-15T10:30:00.000Z",
 *   "level": "info",
 *   "message": "Parcel routed",
 *   "requestId": "req-abc123",
 *   "operation": "route_parcel",
 *   "data": { ... }
 * }
 *
 * SECURITY: Never log sensitive data (full parcel values are okay for an
 * internal routing system, but we avoid logging raw request bodies).
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Default to 'info' in production, 'debug' in development
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? (
  process.env.NODE_ENV === 'production' ? LOG_LEVELS.info : LOG_LEVELS.debug
);

/**
 * Core logging function. Writes JSON to stdout/stderr.
 */
function log(level, message, context = {}) {
  if (LOG_LEVELS[level] > currentLevel) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  const output = JSON.stringify(entry);

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

const logger = {
  error: (message, context) => log('error', message, context),
  warn: (message, context) => log('warn', message, context),
  info: (message, context) => log('info', message, context),
  debug: (message, context) => log('debug', message, context),
};

module.exports = { logger };
