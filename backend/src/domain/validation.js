/**
 * Parcel Validation Logic
 *
 * Pure validation functions with ZERO framework dependencies.
 * These can be tested directly without Express, HTTP, or any I/O.
 *
 * Design Decision: Collect ALL errors rather than failing on the first one.
 * An operator submitting a parcel with weight=-5, value="abc", no country
 * should see all three errors at once — not fix them one at a time.
 *
 * Each field has its own validation function for:
 * - Readability: easy to understand what each rule does
 * - Testability: each validator can be tested independently
 * - Extensibility: adding a new field validation is straightforward
 */

// --- Valid country codes (ISO 3166-1 alpha-2) ---
// Using a Set for O(1) lookups.
// In a production system, this could come from configuration or an external service.
const VALID_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',  // EU countries
  'GB', 'US', 'CA', 'AU', 'JP', 'CN', 'IN', 'BR', 'MX', 'KR',
  'CH', 'NO', 'NZ', 'SG', 'ZA', 'AE', 'SA', 'TR', 'TH', 'MY',
]);

/**
 * Validates raw parcel input and returns either a valid Parcel or a list of errors.
 *
 * @param {object} input - Raw parcel data from the API/UI
 * @returns {{ success: true, parcel: object } | { success: false, errors: Array }}
 *
 * This is the single entry point for validation — the API layer calls this
 * and the routing engine can trust that any Parcel it receives is valid.
 */
function validateParcelInput(input) {
  const errors = [];

  const weight = validateWeight(input.weight, errors);
  const value = validateValue(input.value, errors);
  const destinationCountry = validateDestinationCountry(input.destinationCountry, errors);
  const additionalAttributes = validateAdditionalAttributes(input.additionalAttributes, errors);

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    parcel: {
      weight,
      value,
      destinationCountry,
      additionalAttributes,
    },
  };
}

// --- Individual field validators ---

function parseStrictNumber(raw) {
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw !== 'string') {
    return NaN;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return NaN;
  }
  // Strict numeric format: optional sign, digits with optional decimal, optional exponent.
  // Rejects permissive parses like parseFloat("5abc") -> 5, hex, Infinity, etc.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return NaN;
  }
  const parsed = Number(trimmed);
  return parsed;
}

/**
 * Weight must be a positive number (> 0).
 * Rejects: missing, non-numeric, zero, negative.
 */
function validateWeight(weight, errors) {
  if (weight === undefined || weight === null) {
    errors.push({ field: 'weight', message: 'Weight is required.' });
    return undefined;
  }

  const parsed = parseStrictNumber(weight);

  if (typeof parsed !== 'number' || isNaN(parsed)) {
    errors.push({
      field: 'weight',
      message: 'Weight must be a valid number.',
      value: weight,
    });
    return undefined;
  }

  if (parsed <= 0) {
    errors.push({
      field: 'weight',
      message: 'Weight must be greater than 0.',
      value: weight,
    });
    return undefined;
  }

  // Upper bound to prevent unreasonable values (e.g., typos like 100000 kg)
  if (parsed > 10000) {
    errors.push({
      field: 'weight',
      message: 'Weight must not exceed 10,000 kg.',
      value: weight,
    });
    return undefined;
  }

  return parsed;
}

/**
 * Value must be a non-negative number (>= 0).
 * Rejects: missing, non-numeric, negative.
 * Zero is valid (a parcel can have no declared value).
 */
function validateValue(value, errors) {
  if (value === undefined || value === null) {
    errors.push({ field: 'value', message: 'Value is required.' });
    return undefined;
  }

  const parsed = parseStrictNumber(value);

  if (typeof parsed !== 'number' || isNaN(parsed)) {
    errors.push({
      field: 'value',
      message: 'Value must be a valid number.',
      value: value,
    });
    return undefined;
  }

  if (parsed < 0) {
    errors.push({
      field: 'value',
      message: 'Value must not be negative.',
      value: value,
    });
    return undefined;
  }

  // Upper bound to prevent unreasonable values
  if (parsed > 1000000) {
    errors.push({
      field: 'value',
      message: 'Value must not exceed €1,000,000.',
      value: value,
    });
    return undefined;
  }

  return parsed;
}

/**
 * Destination country must be a non-empty string matching a known country code.
 * Case-insensitive: "de", "De", "DE" all accepted as "DE".
 */
function validateDestinationCountry(country, errors) {
  if (country === undefined || country === null) {
    errors.push({ field: 'destinationCountry', message: 'Destination country is required.' });
    return undefined;
  }

  if (typeof country !== 'string') {
    errors.push({
      field: 'destinationCountry',
      message: 'Destination country must be a string.',
      value: country,
    });
    return undefined;
  }

  const trimmed = country.trim().toUpperCase();

  if (trimmed.length === 0) {
    errors.push({
      field: 'destinationCountry',
      message: 'Destination country must not be empty.',
      value: country,
    });
    return undefined;
  }

  if (!VALID_COUNTRY_CODES.has(trimmed)) {
    errors.push({
      field: 'destinationCountry',
      message: `Unknown country code: "${trimmed}". Use a valid ISO 3166-1 alpha-2 code.`,
      value: country,
    });
    return undefined;
  }

  return trimmed;
}

/**
 * Additional attributes are optional.
 * If provided, must be a plain object with string keys and string/number/boolean values.
 * Rejects: arrays, nested objects, functions.
 */
function validateAdditionalAttributes(attrs, errors) {
  // Not provided — valid, default to empty object
  if (attrs === undefined || attrs === null) {
    return {};
  }

  if (typeof attrs !== 'object' || Array.isArray(attrs)) {
    errors.push({
      field: 'additionalAttributes',
      message: 'Additional attributes must be a plain object.',
      value: attrs,
    });
    return {};
  }

  const result = {};

  for (const [key, val] of Object.entries(attrs)) {
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      errors.push({
        field: `additionalAttributes.${key}`,
        message: `Attribute "${key}" must be a string, number, or boolean.`,
        value: val,
      });
    } else {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Returns the set of valid country codes.
 * Useful for the frontend to populate a dropdown.
 */
function getValidCountryCodes() {
  return Array.from(VALID_COUNTRY_CODES).sort();
}

module.exports = {
  validateParcelInput,
  getValidCountryCodes,
};
