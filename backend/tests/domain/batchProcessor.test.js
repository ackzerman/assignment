/**
 * Batch Input Validation Tests
 *
 * Tests the batch envelope validator:
 * - Rejects missing/non-array/empty/oversized containers
 * - Rejects duplicate parcel IDs up front (ambiguous results otherwise)
 * - Accepts valid batches (auto-generated IDs unaffected)
 *
 * NOTE: batch PROCESSING is asynchronous (worker + Redis). This file covers
 * the pure validation helper only; runtime behavior is tested in tests/batch/.
 */

const { validateBatchInput, assignParcelIds, findDuplicateParcelId, hasParcelId, validateParcelId, DEFAULT_MAX_BATCH_SIZE } = require('../../src/domain/batchProcessor');

// --- Helper: a valid parcel data object ---
function validParcel(overrides = {}) {
  return {
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    ...overrides,
  };
}

// ============================================================
//  validateBatchInput — Container validation
// ============================================================

describe('validateBatchInput', () => {
  test('rejects missing body', () => {
    const result = validateBatchInput(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('parcels');
  });

  test('rejects empty object', () => {
    const result = validateBatchInput({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('parcels');
  });

  test('rejects non-array parcels', () => {
    const result = validateBatchInput({ parcels: 'not-an-array' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('array');
  });

  test('rejects empty array', () => {
    const result = validateBatchInput({ parcels: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one');
  });

  test('rejects batch exceeding max size', () => {
    const parcels = Array.from({ length: 101 }, () => validParcel());
    const result = validateBatchInput({ parcels }, 100);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('100');
  });

  test('accepts valid batch', () => {
    const result = validateBatchInput({ parcels: [validParcel()] });
    expect(result.valid).toBe(true);
    expect(result.parcels).toHaveLength(1);
  });

  test('accepts batch at max size', () => {
    const parcels = Array.from({ length: 100 }, () => validParcel());
    const result = validateBatchInput({ parcels }, 100);
    expect(result.valid).toBe(true);
    expect(result.parcels).toHaveLength(100);
  });

  test('uses default max batch size of 10,000', () => {
    expect(DEFAULT_MAX_BATCH_SIZE).toBe(10000);
    const parcels = Array.from({ length: 10001 }, () => validParcel());
    expect(validateBatchInput({ parcels }).valid).toBe(false);
  });

  // --- Duplicate parcel IDs ---

  test('rejects duplicate parcelIds within the same batch', () => {
    const result = validateBatchInput({
      parcels: [
        validParcel({ parcelId: 'P1' }),
        validParcel({ parcelId: 'P1' }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate parcelId');
  });

  test('treats 1 and "1" as the same parcelId', () => {
    const result = validateBatchInput({
      parcels: [
        validParcel({ parcelId: 1 }),
        validParcel({ parcelId: '1' }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate parcelId');
  });

  test('accepts distinct IDs and parcels without IDs', () => {
    const result = validateBatchInput({
      parcels: [
        validParcel({ parcelId: 'P1' }),
        validParcel({ parcelId: 'P2' }),
        validParcel(),
        validParcel(),
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.parcels).toHaveLength(4);
  });
});

describe('assignParcelIds / findDuplicateParcelId (final ID invariant)', () => {
  test('generates P{index+1} IDs without mutating input', () => {
    const input = [validParcel(), validParcel()];
    delete input[0].parcelId;
    delete input[1].parcelId;
    const assigned = assignParcelIds(input);
    expect(assigned[0].parcelId).toBe('P1');
    expect(assigned[1].parcelId).toBe('P2');
    expect(input[0].parcelId).toBeUndefined();
  });

  test('keeps explicit IDs untouched', () => {
    const assigned = assignParcelIds([validParcel({ parcelId: 'X9' }), validParcel()]);
    expect(assigned[0].parcelId).toBe('X9');
    expect(assigned[1].parcelId).toBe('P2');
  });

  test('detects generated ID colliding with an explicit ID', () => {
    // Parcel A gets generated P1; parcel B explicitly claims P1.
    const assigned = assignParcelIds([
      validParcel(),
      validParcel({ parcelId: 'P1' }),
    ]);
    expect(findDuplicateParcelId(assigned)).toContain('Duplicate parcelId');
  });

  test('accepts fully unique final IDs', () => {
    const assigned = assignParcelIds([validParcel(), validParcel({ parcelId: 'X9' })]);
    expect(findDuplicateParcelId(assigned)).toBeNull();
  });
});

// ============================================================
//  parcelId contract — presence (not truthiness) + type validation
// ============================================================

describe('parcelId contract', () => {
  test.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['P1', true],
    ['0', true],
    [0, true],
    [42, true],
    [false, true],
  ])('hasParcelId(%p) → %p', (value, expected) => {
    expect(hasParcelId(value)).toBe(expected);
  });

  test.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['P1', null],
    [0, null],
    [42, null],
    [{}, 'parcelId must be a string or a finite number.'],
    [['P1'], 'parcelId must be a string or a finite number.'],
    [true, 'parcelId must be a string or a finite number.'],
    [NaN, 'parcelId must be a string or a finite number.'],
    [Infinity, 'parcelId must be a string or a finite number.'],
  ])('validateParcelId(%p) → %p', (value, expected) => {
    expect(validateParcelId(value)).toBe(expected);
  });

  test('validateBatchInput rejects non-string/non-number parcelIds', () => {
    expect(validateBatchInput({ parcels: [validParcel({ parcelId: {} })] }).valid).toBe(false);
    expect(validateBatchInput({ parcels: [validParcel({ parcelId: [1] })] }).valid).toBe(false);
  });

  test('validateBatchInput accepts 0 as an explicit parcelId', () => {
    const result = validateBatchInput({ parcels: [validParcel({ parcelId: 0 })] });
    expect(result.valid).toBe(true);
  });

  test('assignParcelIds preserves an explicit 0 instead of regenerating', () => {
    const assigned = assignParcelIds([validParcel({ parcelId: 0 }), validParcel()]);
    expect(assigned[0].parcelId).toBe(0);
    expect(assigned[1].parcelId).toBe('P2');
  });
});
