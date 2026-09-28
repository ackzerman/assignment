/**
 * Global Error Handling Middleware
 *
 * This is the last middleware in the Express chain.
 * It catches all errors and returns a consistent JSON response.
 *
 * Design Decision:
 * - Validation errors (ValidationFailedError): return structured field-level errors
 * - JSON parse errors (SyntaxError): return 400 with helpful message
 * - Entity-too-large (body over the 10mb limit): return 413, never 500
 * - Operational errors (AppError with isOperational=true): return error details to client
 * - Programming errors (unhandled exceptions): log full error, return generic 500 to client
 * - Never expose stack traces or internal details in production
 */

const { AppError, ValidationFailedError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { recordError } = require('../../observability/metrics');

function errorHandler(err, req, res, _next) {
  // Entity-too-large — request body exceeded the express.json limit.
  // Must be 413 (not 500): the client can fix this by sending less data.
  // body-parser surfaces this as err.type === 'entity.too.large' with
  // status/statusCode 413; match all three shapes defensively.
  if (
    err.type === 'entity.too.large' ||
    err.status === 413 ||
    err.statusCode === 413
  ) {
    logger.warn('Request body too large', { requestId: req.id });
    res.status(413).json({
      status: 'error',
      message: 'Request body too large. Maximum size is 10 MB.',
    });
    return;
  }

  // Validation errors — return structured field-level errors
  if (err instanceof ValidationFailedError) {
    res.status(400).json({
      status: 'error',
      message: err.message,
      errors: err.validationErrors,
    });
    return;
  }

  // JSON parse errors — client sent malformed JSON
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    logger.warn('Malformed JSON in request', {
      requestId: req.id,
      error: err.message,
    });
    res.status(400).json({
      status: 'error',
      message: 'Request body contains invalid JSON. Please check the format.',
    });
    return;
  }

  // Known operational errors — safe to return message.
  // 5xx operational failures (503 Redis/queue down) also feed the error
  // metric so outage storms are visible to anomaly detection; 4xx (incl.
  // 429 backpressure/rate-limit) stays out — those are client-caused, and
  // counting every throttled poll as a system error would fake spikes.
  if (err instanceof AppError && err.isOperational) {
    if (err.statusCode >= 500) recordError();
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
    return;
  }

  // Unknown/programming errors — log internally, return generic message
  // SECURITY: Never expose stack traces, file paths, or internal details
  recordError();
  logger.error('Unhandled error', {
    requestId: req.id,
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    status: 'error',
    message: 'An unexpected error occurred. Please try again later.',
  });
}

module.exports = { errorHandler };
