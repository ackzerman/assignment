/**
 * Shared configuration parsing.
 *
 * Environment configuration is untrusted input: a single helper validates
 * positive-integer settings in one place so a bad value (empty, negative,
 * NaN, fractional) can never silently disable a safety control — the secure
 * default applies instead.
 */

/**
 * Parses a positive integer environment value, falling back safely.
 *
 * @param {*} value - Raw value (usually a string from process.env)
 * @param {number} fallback - Safe default used when invalid
 * @returns {number} A positive integer, or the fallback
 */
function positiveIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  positiveIntOrDefault,
};
