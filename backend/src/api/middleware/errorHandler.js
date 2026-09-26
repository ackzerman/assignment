/**
 * Global Error Handling Middleware
 *
 * This is the last middleware in the Express chain.
 * It catches all errors and returns a consistent JSON response.
 *
 * Design Decision:
 * - Validation errors (ValidationFailedError): return structured field-level errors
 * - JSON parse errors (SyntaxError): return 400 with helpful message
 * - Operational errors (AppError with isOperational=true): return error details to client
 * - Programming errors (unhandled exceptions): log full error, return generic 500 to client
 * - Never expose stack traces or internal details in production
 */

const { AppError, ValidationFailedError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { recordError } = require('../../observability/metrics');

function errorHandler(err, req, res, _next) {
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

  // Known operational errors — safe to return message
  if (err instanceof AppError && err.isOperational) {
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
