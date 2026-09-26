/**
 * Custom Application Errors
 *
 * Distinguishes between:
 * - Client errors (4xx): safe to show details to the user
 * - Server errors (5xx): log details, show generic message to user
 *
 * This separation is important for:
 * - Security: don't leak internal details in 5xx responses
 * - Debugging: structured errors are easier to log and search
 * - UX: operators see helpful messages, not stack traces
 */

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = 'AppError';
  }
}

/**
 * Specific error for validation failures.
 * Carries structured field-level errors for the UI.
 */
class ValidationFailedError extends AppError {
  constructor(validationErrors) {
    super('Validation failed', 400, true);
    this.validationErrors = validationErrors;
    this.name = 'ValidationFailedError';
  }
}

module.exports = { AppError, ValidationFailedError };
