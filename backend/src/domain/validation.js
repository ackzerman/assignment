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

// --- Valid country codes (full ISO 3166-1 alpha-2 set, 249 codes) ---
// Using a Set for O(1) lookups.
const VALID_COUNTRY_CODES = new Set([
  'AF', 'AX', 'AL', 'DZ', 'AS', 'AD', 'AO', 'AI', 'AQ', 'AG',
  'AR', 'AM', 'AW', 'AU', 'AT', 'AZ', 'BS', 'BH', 'BD', 'BB',
  'BY', 'BE', 'BZ', 'BJ', 'BM', 'BT', 'BO', 'BQ', 'BA', 'BW',
  'BV', 'BR', 'IO', 'BN', 'BG', 'BF', 'BI', 'CV', 'KH', 'CM',
  'CA', 'KY', 'CF', 'TD', 'CL', 'CN', 'CX', 'CC', 'CO', 'KM',
  'CG', 'CD', 'CK', 'CR', 'CI', 'HR', 'CU', 'CW', 'CY', 'CZ',
  'DK', 'DJ', 'DM', 'DO', 'EC', 'EG', 'SV', 'GQ', 'ER', 'EE',
  'SZ', 'ET', 'FK', 'FO', 'FJ', 'FI', 'FR', 'GF', 'PF', 'TF',
  'GA', 'GM', 'GE', 'DE', 'GH', 'GI', 'GR', 'GL', 'GD', 'GP',
  'GU', 'GT', 'GG', 'GN', 'GW', 'GY', 'HT', 'HM', 'VA', 'HN',
  'HK', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IM', 'IL',
  'IT', 'JM', 'JP', 'JE', 'JO', 'KZ', 'KE', 'KI', 'KP', 'KR',
  'KW', 'KG', 'LA', 'LV', 'LB', 'LS', 'LR', 'LY', 'LI', 'LT',
  'LU', 'MO', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH', 'MQ',
  'MR', 'MU', 'YT', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MS',
  'MA', 'MZ', 'MM', 'NA', 'NR', 'NP', 'NL', 'NC', 'NZ', 'NI',
  'NE', 'NG', 'NU', 'NF', 'MK', 'MP', 'NO', 'OM', 'PK', 'PW',
  'PS', 'PA', 'PG', 'PY', 'PE', 'PH', 'PN', 'PL', 'PT', 'PR',
  'QA', 'RE', 'RO', 'RU', 'RW', 'BL', 'SH', 'KN', 'LC', 'MF',
  'PM', 'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL',
  'SG', 'SX', 'SK', 'SI', 'SB', 'SO', 'ZA', 'GS', 'SS', 'ES',
  'LK', 'SD', 'SR', 'SJ', 'SE', 'CH', 'SY', 'TW', 'TJ', 'TZ',
  'TH', 'TL', 'TG', 'TK', 'TO', 'TT', 'TN', 'TR', 'TM', 'TC',
  'TV', 'UG', 'UA', 'AE', 'GB', 'US', 'UM', 'UY', 'UZ', 'VU',
  'VE', 'VN', 'VG', 'VI', 'WF', 'EH', 'YE', 'ZM', 'ZW',
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
  // Non-object input (null, arrays, primitives) is malformed, not a crash:
  // report it as validation errors so callers never throw on bad shapes.
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ field: 'parcel', message: 'Parcel must be an object.', value: input }],
    };
  }

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
 * Weight must be a positive, finite number (> 0).
 * Rejects: missing, non-numeric, non-finite, zero, negative.
 * No upper bound: the routing rules (Mail/Regular/Heavy) cover all weights.
 */
function validateWeight(weight, errors) {
  if (weight === undefined || weight === null) {
    errors.push({ field: 'weight', message: 'Weight is required.' });
    return undefined;
  }

  const parsed = parseStrictNumber(weight);

  if (typeof parsed !== 'number' || isNaN(parsed) || !isFinite(parsed)) {
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

  return parsed;
}

/**
 * Value must be a finite, non-negative number (>= 0).
 * Rejects: missing, non-numeric, non-finite, negative.
 * Zero is valid (a parcel can have no declared value).
 * No upper bound: approval rules apply at any value (e.g. Insurance).
 */
function validateValue(value, errors) {
  if (value === undefined || value === null) {
    errors.push({ field: 'value', message: 'Value is required.' });
    return undefined;
  }

  const parsed = parseStrictNumber(value);

  if (typeof parsed !== 'number' || isNaN(parsed) || !isFinite(parsed)) {
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
