/**
 * Validation Tests
 *
 * Tests the pure domain validation logic directly — no HTTP, no Express.
 * This is the correct way to test business rules (Rule 5).
 *
 * Organized by field, then by scenario:
 * - Valid inputs (positive tests)
 * - Invalid inputs (negative tests)
 * - Boundary conditions (Rule 6)
 * - Edge cases
 */

import { validateParcelInput } from '../../src/domain/validation';

// --- Helper to assert validation failure ---
function expectFailure(input: Record<string, unknown>, expectedField: string) {
  const result = validateParcelInput(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.errors.some((e) => e.field === expectedField)).toBe(true);
  }
}

// --- Helper to assert validation success ---
function expectSuccess(input: Record<string, unknown>) {
  const result = validateParcelInput(input);
  expect(result.success).toBe(true);
  return result;
}

// A valid parcel input to use as a base for tests
const VALID_INPUT = {
  weight: 5,
  value: 100,
  destinationCountry: 'DE',
  additionalAttributes: {},
};

describe('Parcel Validation', () => {
  // ===========================================================
  // VALID INPUT
  // ===========================================================
  describe('Valid Inputs', () => {
    it('should accept a valid parcel with all fields', () => {
      const result = expectSuccess(VALID_INPUT);
      if (result.success) {
        expect(result.parcel.weight).toBe(5);
        expect(result.parcel.value).toBe(100);
        expect(result.parcel.destinationCountry).toBe('DE');
      }
    });

    it('should accept a parcel without additionalAttributes', () => {
      const result = expectSuccess({
        weight: 1,
        value: 0,
        destinationCountry: 'US',
      });
      if (result.success) {
        expect(result.parcel.additionalAttributes).toEqual({});
      }
    });

    it('should accept a parcel with value of 0', () => {
      expectSuccess({ ...VALID_INPUT, value: 0 });
    });

    it('should accept a parcel with additionalAttributes', () => {
      const result = expectSuccess({
        ...VALID_INPUT,
        additionalAttributes: { fragile: true, priority: 'high', floor: 3 },
      });
      if (result.success) {
        expect(result.parcel.additionalAttributes).toEqual({
          fragile: true,
          priority: 'high',
          floor: 3,
        });
      }
    });

    it('should accept country codes case-insensitively', () => {
      const result = expectSuccess({ ...VALID_INPUT, destinationCountry: 'de' });
      if (result.success) {
        expect(result.parcel.destinationCountry).toBe('DE'); // Normalized to uppercase
      }
    });

    it('should trim and normalize country codes', () => {
      const result = expectSuccess({ ...VALID_INPUT, destinationCountry: '  fr  ' });
      if (result.success) {
        expect(result.parcel.destinationCountry).toBe('FR');
      }
    });
  });

  // ===========================================================
  // WEIGHT VALIDATION
  // ===========================================================
  describe('Weight Validation', () => {
    it('should reject missing weight', () => {
      expectFailure({ value: 100, destinationCountry: 'DE' }, 'weight');
    });

    it('should reject null weight', () => {
      expectFailure({ ...VALID_INPUT, weight: null }, 'weight');
    });

    it('should reject non-numeric weight (string)', () => {
      expectFailure({ ...VALID_INPUT, weight: 'hello' }, 'weight');
    });

    it('should reject non-numeric weight (boolean)', () => {
      expectFailure({ ...VALID_INPUT, weight: true }, 'weight');
    });

    it('should reject negative weight', () => {
      expectFailure({ ...VALID_INPUT, weight: -5 }, 'weight');
    });

    it('should reject zero weight', () => {
      expectFailure({ ...VALID_INPUT, weight: 0 }, 'weight');
    });

    it('should reject weight exceeding 10,000 kg', () => {
      expectFailure({ ...VALID_INPUT, weight: 10001 }, 'weight');
    });

    it('should accept weight at upper bound (10,000 kg)', () => {
      expectSuccess({ ...VALID_INPUT, weight: 10000 });
    });

    it('should accept very small positive weight', () => {
      expectSuccess({ ...VALID_INPUT, weight: 0.01 });
    });

    it('should accept weight as numeric string', () => {
      const result = expectSuccess({ ...VALID_INPUT, weight: '5.5' });
      if (result.success) {
        expect(result.parcel.weight).toBe(5.5);
      }
    });
  });

  // ===========================================================
  // VALUE VALIDATION
  // ===========================================================
  describe('Value Validation', () => {
    it('should reject missing value', () => {
      expectFailure({ weight: 5, destinationCountry: 'DE' }, 'value');
    });

    it('should reject null value', () => {
      expectFailure({ ...VALID_INPUT, value: null }, 'value');
    });

    it('should reject non-numeric value', () => {
      expectFailure({ ...VALID_INPUT, value: 'abc' }, 'value');
    });

    it('should reject negative value', () => {
      expectFailure({ ...VALID_INPUT, value: -1 }, 'value');
    });

    it('should accept zero value', () => {
      expectSuccess({ ...VALID_INPUT, value: 0 });
    });

    it('should reject value exceeding €1,000,000', () => {
      expectFailure({ ...VALID_INPUT, value: 1_000_001 }, 'value');
    });

    it('should accept value at upper bound (€1,000,000)', () => {
      expectSuccess({ ...VALID_INPUT, value: 1_000_000 });
    });

    it('should accept value as numeric string', () => {
      const result = expectSuccess({ ...VALID_INPUT, value: '250.50' });
      if (result.success) {
        expect(result.parcel.value).toBe(250.5);
      }
    });
  });

  // ===========================================================
  // DESTINATION COUNTRY VALIDATION
  // ===========================================================
  describe('Destination Country Validation', () => {
    it('should reject missing country', () => {
      expectFailure({ weight: 5, value: 100 }, 'destinationCountry');
    });

    it('should reject null country', () => {
      expectFailure({ ...VALID_INPUT, destinationCountry: null }, 'destinationCountry');
    });

    it('should reject non-string country', () => {
      expectFailure({ ...VALID_INPUT, destinationCountry: 123 }, 'destinationCountry');
    });

    it('should reject empty string country', () => {
      expectFailure({ ...VALID_INPUT, destinationCountry: '' }, 'destinationCountry');
    });

    it('should reject whitespace-only country', () => {
      expectFailure({ ...VALID_INPUT, destinationCountry: '   ' }, 'destinationCountry');
    });

    it('should reject unknown country code', () => {
      expectFailure({ ...VALID_INPUT, destinationCountry: 'XX' }, 'destinationCountry');
    });

    it('should accept valid country code', () => {
      expectSuccess({ ...VALID_INPUT, destinationCountry: 'FR' });
    });
  });

  // ===========================================================
  // ADDITIONAL ATTRIBUTES VALIDATION
  // ===========================================================
  describe('Additional Attributes Validation', () => {
    it('should accept undefined additionalAttributes', () => {
      expectSuccess({ weight: 5, value: 100, destinationCountry: 'DE' });
    });

    it('should accept null additionalAttributes', () => {
      expectSuccess({ ...VALID_INPUT, additionalAttributes: null });
    });

    it('should accept empty object', () => {
      expectSuccess({ ...VALID_INPUT, additionalAttributes: {} });
    });

    it('should accept valid string, number, boolean values', () => {
      expectSuccess({
        ...VALID_INPUT,
        additionalAttributes: {
          label: 'urgent',
          priority: 1,
          fragile: true,
        },
      });
    });

    it('should reject array as additionalAttributes', () => {
      expectFailure(
        { ...VALID_INPUT, additionalAttributes: [1, 2, 3] },
        'additionalAttributes'
      );
    });

    it('should reject nested objects in attributes', () => {
      const result = validateParcelInput({
        ...VALID_INPUT,
        additionalAttributes: { nested: { key: 'value' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'additionalAttributes.nested')).toBe(true);
      }
    });

    it('should reject null values in attributes', () => {
      const result = validateParcelInput({
        ...VALID_INPUT,
        additionalAttributes: { key: null },
      });
      expect(result.success).toBe(false);
    });
  });

  // ===========================================================
  // MULTIPLE ERRORS
  // ===========================================================
  describe('Multiple Errors', () => {
    it('should report ALL validation errors at once', () => {
      const result = validateParcelInput({
        weight: -5,
        value: 'abc',
        // missing destinationCountry
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Should have errors for weight, value, AND country
        const errorFields = result.errors.map((e) => e.field);
        expect(errorFields).toContain('weight');
        expect(errorFields).toContain('value');
        expect(errorFields).toContain('destinationCountry');
      }
    });

    it('should report errors for completely empty input', () => {
      const result = validateParcelInput({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThanOrEqual(3); // weight, value, country
      }
    });
  });
});
