/**
 * Batch Processing Tests
 *
 * Tests the batch processor's ability to:
 * - Process valid batches correctly
 * - Handle mixed-validity batches (valid + invalid parcels)
 * - Reject invalid batch containers
 * - Process large batches in chunks
 * - Report progress during processing
 * - Handle edge cases gracefully
 */

const { processBatch, processOneParcel, validateBatchInput } = require('../../src/domain/batchProcessor');

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
});

// ============================================================
//  processOneParcel — Single parcel within a batch
// ============================================================

describe('processOneParcel', () => {
  test('routes a valid parcel', () => {
    const result = processOneParcel(validParcel(), 0);
    expect(result.status).toBe('routed');
    expect(result.department).toBe('Regular');
    expect(result.index).toBe(0);
  });

  test('returns invalid for bad data', () => {
    const result = processOneParcel({ weight: -5, value: 'abc' }, 3);
    expect(result.status).toBe('invalid');
    expect(result.index).toBe(3);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('preserves index for error tracking', () => {
    const result = processOneParcel(validParcel(), 42);
    expect(result.index).toBe(42);
  });

  test('routes Mail department', () => {
    const result = processOneParcel(validParcel({ weight: 0.5 }), 0);
    expect(result.department).toBe('Mail');
  });

  test('routes Heavy department', () => {
    const result = processOneParcel(validParcel({ weight: 15 }), 0);
    expect(result.department).toBe('Heavy');
  });

  test('detects insurance requirement', () => {
    const result = processOneParcel(validParcel({ value: 2000 }), 0);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvals.length).toBeGreaterThan(0);
  });
});

// ============================================================
//  processBatch — Full batch processing
// ============================================================

describe('processBatch', () => {
  test('processes all-valid batch', async () => {
    const parcels = [
      validParcel({ weight: 0.5 }),
      validParcel({ weight: 5 }),
      validParcel({ weight: 15 }),
    ];

    const result = await processBatch(parcels);

    expect(result.summary.total).toBe(3);
    expect(result.summary.successful).toBe(3);
    expect(result.summary.failed).toBe(0);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].department).toBe('Mail');
    expect(result.results[1].department).toBe('Regular');
    expect(result.results[2].department).toBe('Heavy');
  });

  test('processes mixed-validity batch', async () => {
    const parcels = [
      validParcel({ weight: 2 }),           // valid → Regular
      { weight: -1, value: 100, destinationCountry: 'DE' }, // invalid
      validParcel({ weight: 0.5 }),          // valid → Mail
      { weight: 5 },                         // invalid (missing value, country)
    ];

    const result = await processBatch(parcels);

    expect(result.summary.total).toBe(4);
    expect(result.summary.successful).toBe(2);
    expect(result.summary.failed).toBe(2);

    // Check individual results
    expect(result.results[0].status).toBe('routed');
    expect(result.results[0].department).toBe('Regular');

    expect(result.results[1].status).toBe('invalid');
    expect(result.results[1].errors.length).toBeGreaterThan(0);

    expect(result.results[2].status).toBe('routed');
    expect(result.results[2].department).toBe('Mail');

    expect(result.results[3].status).toBe('invalid');
  });

  test('processes all-invalid batch', async () => {
    const parcels = [
      { weight: -1 },
      { value: 'abc' },
      {},
    ];

    const result = await processBatch(parcels);

    expect(result.summary.total).toBe(3);
    expect(result.summary.successful).toBe(0);
    expect(result.summary.failed).toBe(3);
    expect(result.results.every(r => r.status === 'invalid')).toBe(true);
  });

  test('handles single parcel batch', async () => {
    const result = await processBatch([validParcel()]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.successful).toBe(1);
    expect(result.results[0].status).toBe('routed');
  });

  test('includes processedAt timestamp', async () => {
    const result = await processBatch([validParcel()]);
    expect(result.summary.processedAt).toBeDefined();
    expect(() => new Date(result.summary.processedAt)).not.toThrow();
  });

  test('preserves parcel index in results', async () => {
    const parcels = Array.from({ length: 5 }, (_, i) =>
      validParcel({ weight: i + 1 })
    );

    const result = await processBatch(parcels);

    result.results.forEach((r, i) => {
      expect(r.index).toBe(i);
    });
  });

  // --- Chunked processing ---

  test('processes in chunks of specified size', async () => {
    const progressCalls = [];
    const parcels = Array.from({ length: 10 }, () => validParcel());

    await processBatch(parcels, {
      chunkSize: 3,
      onProgress: (progress) => progressCalls.push({ ...progress }),
    });

    // 10 parcels / 3 per chunk = 4 chunks (3, 3, 3, 1)
    expect(progressCalls.length).toBe(4);

    // First chunk: 3 processed
    expect(progressCalls[0].processed).toBe(3);
    expect(progressCalls[0].total).toBe(10);

    // Second chunk: 6 processed
    expect(progressCalls[1].processed).toBe(6);

    // Third chunk: 9 processed
    expect(progressCalls[2].processed).toBe(9);

    // Final chunk: 10 processed
    expect(progressCalls[3].processed).toBe(10);
    expect(progressCalls[3].successful).toBe(10);
    expect(progressCalls[3].failed).toBe(0);
  });

  test('progress reflects mixed validity', async () => {
    const progressCalls = [];
    const parcels = [
      validParcel(),
      { weight: -1 },  // invalid
      validParcel(),
    ];

    await processBatch(parcels, {
      chunkSize: 2,
      onProgress: (progress) => progressCalls.push({ ...progress }),
    });

    // After first chunk (2 parcels: 1 valid, 1 invalid)
    expect(progressCalls[0].successful).toBe(1);
    expect(progressCalls[0].failed).toBe(1);
  });

  // --- Large batch (lightweight stress test) ---

  test('handles 1000 parcels efficiently', async () => {
    const parcels = Array.from({ length: 1000 }, (_, i) =>
      validParcel({ weight: (i % 20) + 0.1 })
    );

    const start = Date.now();
    const result = await processBatch(parcels, { chunkSize: 100 });
    const elapsed = Date.now() - start;

    expect(result.summary.total).toBe(1000);
    expect(result.summary.successful).toBe(1000);
    // Should complete in well under 5 seconds
    expect(elapsed).toBeLessThan(5000);
  });

  // --- Edge case: non-object items in array ---

  test('handles non-object items in batch gracefully', async () => {
    const parcels = [
      validParcel(),
      null,
      'not-an-object',
      42,
      validParcel(),
    ];

    const result = await processBatch(parcels);

    expect(result.summary.total).toBe(5);
    // The null, string, and number should fail validation, not crash
    expect(result.summary.successful).toBe(2);
    expect(result.summary.failed).toBe(3);
  });
});
