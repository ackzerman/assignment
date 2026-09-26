/**
 * Core Parcel Domain Model
 *
 * This file defines the parcel data structure and related types.
 * It has ZERO dependencies on Express, React, or any framework.
 *
 * Design Decision:
 * - Interface (not class) because parcels are plain data, not objects with behavior.
 * - additionalAttributes is a flexible key-value map for future extensibility
 *   (e.g., "fragile: true", "hazmat: true") without changing the core model.
 * - ParcelInput is the raw data from the user (all fields potentially any type).
 * - Parcel is the validated, type-safe version that the routing engine works with.
 */

// --- Raw input from the user (before validation) ---

/**
 * Represents raw parcel data as received from the API or UI.
 * All fields are typed as `unknown` because we cannot trust external input.
 */
export interface ParcelInput {
  weight?: unknown;
  value?: unknown;
  destinationCountry?: unknown;
  additionalAttributes?: unknown;
}

// --- Validated domain model ---

/**
 * Represents a validated parcel ready for routing.
 * If you have a Parcel instance, all fields are guaranteed to be valid.
 */
export interface Parcel {
  weight: number;              // kg, must be > 0
  value: number;               // €, must be >= 0
  destinationCountry: string;  // ISO-like country code or name, non-empty
  additionalAttributes: Record<string, string | number | boolean>;
}

// --- Validation result ---

/**
 * Represents the outcome of validating a ParcelInput.
 * Uses a discriminated union so the caller MUST check success before accessing data.
 *
 * Why discriminated union instead of throwing exceptions?
 * - Validation failure is expected (operators will make mistakes), not exceptional.
 * - Collecting all errors at once is better UX than failing on the first error.
 * - Makes the validation function pure and easy to test.
 */
export type ValidationResult =
  | { success: true; parcel: Parcel }
  | { success: false; errors: ValidationError[] };

/**
 * A single validation error with field-level detail.
 * Provides enough context for the UI to highlight the specific problem.
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: unknown; // The rejected value, for debugging
}
