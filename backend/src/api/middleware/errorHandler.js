/**
 * Global Error Handling Middleware
 *
 * This is the last middleware in the Express chain.
 * It catches all errors and returns a consistent JSON response.
 *
 * Design Decision:
 * - Operational errors (AppError with isOperational=true): return error details to client
 * - Programming errors (unhandled exceptions): log full error, return generic 500 to client
 * - Never expose stack traces or internal details in production
 */

const { AppError, ValidationFailedError } = require('../../errors/AppError');

function errorHandler(err, _req, res, _next) {
  // Validation errors — return structured field-level errors
  if (err instanceof ValidationFailedError) {
    res.status(400).json({
      status: 'error',
      message: err.message,
      errors: err.validationErrors,
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
  console.error('[UNHANDLED ERROR]', {
    name: err.name,
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });

  res.status(500).json({
    status: 'error',
    message: 'An unexpected error occurred. Please try again later.',
  });
}

module.exports = { errorHandler };
