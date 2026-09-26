/**
 * Custom Application Error
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

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // Maintain proper prototype chain (important for instanceof checks)
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Specific error for validation failures.
 * Carries structured field-level errors for the UI.
 */
export class ValidationFailedError extends AppError {
  public readonly validationErrors: Array<{
    field: string;
    message: string;
    value?: unknown;
  }>;

  constructor(
    validationErrors: Array<{ field: string; message: string; value?: unknown }>
  ) {
    super('Validation failed', 400, true);
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, ValidationFailedError.prototype);
  }
}
