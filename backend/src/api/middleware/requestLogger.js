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
const { recordHttpRequest } = require('../../observability/metrics');

// Request IDs are echoed into response headers and structured logs, so an
// attacker-controlled value must be constrained: cap length and charset,
// otherwise an arbitrary huge or dangerous value propagates everywhere.
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_\-.:]+$/;

/**
 * Returns true for safe client-provided request IDs.
 */
function isValidRequestId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REQUEST_ID_LENGTH
    && REQUEST_ID_PATTERN.test(value)
  );
}

/**
 * Assigns a unique request ID to every request.
 * A client-provided X-Request-ID is reused only when safe (for distributed
 * tracing); otherwise a server-side UUID is generated.
 * The ID is attached to req.id and returned in the X-Request-ID response header.
 */
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = isValidRequestId(incoming) ? incoming : randomUUID();
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

    // Master observability: every request counted (count, errors, latency).
    try {
      recordHttpRequest(res.statusCode, duration);
    } catch {
      // Metrics must never break request handling.
    }

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

module.exports = { requestId, requestLogger, isValidRequestId, MAX_REQUEST_ID_LENGTH };
