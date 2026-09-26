/**
 * Core Parcel Domain Model
 *
 * This file defines the parcel data structure and validation result shapes.
 * It has ZERO dependencies on Express or any framework.
 *
 * Design Decision:
 * - We use plain objects (not classes) because parcels are data, not behavior.
 * - additionalAttributes is a flexible key-value map for future extensibility
 *   (e.g., { fragile: true, hazmat: true }) without changing the core model.
 *
 * A validated parcel looks like:
 * {
 *   weight: number,              // kg, must be > 0
 *   value: number,               // €, must be >= 0
 *   destinationCountry: string,  // ISO 3166-1 alpha-2 code
 *   additionalAttributes: {}     // key-value pairs (string/number/boolean values)
 * }
 *
 * Validation result is either:
 *   { success: true, parcel: { ... } }
 *   { success: false, errors: [{ field, message, value? }, ...] }
 *
 * Why this pattern instead of throwing exceptions?
 * - Validation failure is EXPECTED (operators will make mistakes), not exceptional.
 * - Collecting all errors at once is better UX than failing on the first error.
 * - Makes the validation function pure and easy to test.
 */

// This file only documents the shapes — the actual validation logic is in validation.js.
// In plain JS we don't have interfaces, but this file serves as the
// canonical documentation of the domain model.

module.exports = {};
