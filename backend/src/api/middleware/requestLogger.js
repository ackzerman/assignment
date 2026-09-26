/**
 * Request Logging & Tracking Middleware
 *
 * Provides:
 * 1. Unique request ID for every request (for log correlation)
 * 2. Request/response logging with timing
 *
 * Design Decision: UUID vs counter vs crypto.randomUUID
 * - crypto.randomUUID() is built into Node.js (no dependency)
 * - UUIDs are globally unique and safe for distributed systems
 * - We also support client-provided request IDs via X-Request-ID header
 *   (useful when tracing requests through multiple services)
 */

const { randomUUID } = require('crypto');
const { logger } = require('../../observability/logger');

/**
 * Assigns a unique request ID to every request.
 * If the client sends an X-Request-ID header, we reuse it (for distributed tracing).
 * The ID is attached to req.id and returned in the X-Request-ID response header.
 */
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

/**
 * Logs incoming requests and outgoing responses with timing.
 *
 * Logged fields match the spec:
 * - timestamp (from logger)
 * - request ID
 * - operation (method + path)
 * - processing time
 * - status code
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - start;

    // Skip health check logging (too noisy)
    if (req.path === '/api/health') return;

    const logData = {
      requestId: req.id,
      operation: `${req.method} ${req.path}`,
      statusCode: res.statusCode,
      durationMs: duration,
    };

    if (res.statusCode >= 400) {
      logger.warn('Request completed with error', logData);
    } else {
      logger.info('Request completed', logData);
    }
  });

  next();
}

module.exports = { requestId, requestLogger };
