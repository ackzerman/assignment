/**
 * Targeted fixes — regression tests (batch validation, worker error
 * semantics, utilization metric, chunk claim release).
 *
 * Failure injection via mocks; no real process crashes or Redis needed.
 */

const db = require('../../src/infrastructure/database');
const {
  initDatabase,
  closeDatabase,
  createBatch,
  getBatch,
  getBatchResultCount,
  getBatchResults,
  getChunk,
} = db;
const { validateBatchInput } = require('../../src/domain/batchProcessor');
const { validateParcelInput } = require('../../src/domain/validation');
const { processBatchJob } = require('../../src/infrastructure/worker');
const {
  resetMetrics,
  getMetrics,
  workerJobStarted,
  workerJobFinished,
} = require('../../src/observability/metrics');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-FIX-${prefix}-${Date.now()}-${seq}`;
}

function parcels(n) {
  return Array.from({ length: n }, (_, i) => ({
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    parcelId: `P${i + 1}`,
  }));
}

function mockJob(id) {
  return { id, data: {}, updateProgress: jest.fn(async () => {}) };
}

describe('Targeted fixes', () => {
  beforeAll(() => {
    initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- Item 7: duplicate parcel IDs rejected at batch validation ---

  it('rejects duplicate parcelIds within the same batch', () => {
    const res = validateBatchInput({
      parcels: [
        { weight: 1, value: 10, destinationCountry: 'DE', parcelId: 'P1' },
        { weight: 2, value: 20, destinationCountry: 'DE', parcelId: 'P1' },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Duplicate parcelId');
  });

  it('treats 1 and "1" as the same parcelId', () => {
    const res = validateBatchInput({
      parcels: [
        { weight: 1, value: 10, destinationCountry: 'DE', parcelId: 1 },
        { weight: 2, value: 20, destinationCountry: 'DE', parcelId: '1' },
      ],
    });
    expect(res.valid).toBe(false);
  });

  it('accepts distinct IDs and auto-generated IDs', () => {
    expect(validateBatchInput({ parcels: parcels(3) }).valid).toBe(true);
    expect(
      validateBatchInput({
        parcels: [
          { weight: 1, value: 10, destinationCountry: 'DE' },
          { weight: 2, value: 20, destinationCountry: 'DE' },
        ],
      }).valid,
    ).toBe(true);
  });

  // --- Item 4: strict numeric validation ---

  it.each([['5abc'], ['10kg']])('rejects malformed weight %p', (weight) => {
    const res = validateParcelInput({ weight, value: 10, destinationCountry: 'DE' });
    expect(res.success).toBe(false);
  });

  it('rejects malformed value "1000foo"', () => {
    const res = validateParcelInput({ weight: 2, value: '1000foo', destinationCountry: 'DE' });
    expect(res.success).toBe(false);
  });

  it('keeps valid numerics and boundaries working', () => {
    expect(validateParcelInput({ weight: '2.5', value: 10, destinationCountry: 'DE' }).success).toBe(true);
    expect(validateParcelInput({ weight: 1, value: 1000, destinationCountry: 'DE' }).success).toBe(true);
    expect(validateParcelInput({ weight: 10, value: 1000, destinationCountry: 'DE' }).success).toBe(true);
  });

  // --- Items 5+9: unexpected worker errors propagate + hit the error metric ---

  it('unexpected persistence failure propagates, records a system error, releases the claim, and never becomes a parcel row', async () => {
    resetMetrics();
    const id = batchId('propagate');
    createBatch(id, 4, parcels(4), 'anonymous', 2);

    jest.spyOn(db, 'persistChunkAndMarkDone').mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const job = mockJob('job-unexpected');
    job.data = { batchId: id };
    await expect(processBatchJob(job, 2, { leaseMs: 0 })).rejects.toThrow('db down');

    expect(getMetrics().errors).toBe(1);
    expect(getChunk(id, 0).status).toBe('PENDING');
    expect(getBatchResultCount(id)).toBe(0);
    expect(getBatchResults(id).filter((r) => r.status === 'error')).toHaveLength(0);
    expect(getBatch(id).status).toBe('PROCESSING');

    // Retry after recovery succeeds with no duplicates.
    const retry = mockJob('job-retry');
    retry.data = { batchId: id };
    const summary = await processBatchJob(retry, 2, { leaseMs: 0 });
    expect(summary.status).toBe('COMPLETED');
    expect(getBatchResultCount(id)).toBe(4);
  });

  // --- Item 8: utilization uses increment/decrement ---

  it('counts concurrent worker jobs correctly', () => {
    resetMetrics();
    workerJobStarted();
    workerJobStarted();
    workerJobStarted();
    expect(getMetrics().workerActiveJobs).toBe(3);
    workerJobFinished();
    expect(getMetrics().workerActiveJobs).toBe(2);
    workerJobFinished();
    workerJobFinished();
    workerJobFinished(); // extra finish must not go negative
    expect(getMetrics().workerActiveJobs).toBe(0);
  });

  // --- Claim release unit behavior ---

  it('releaseChunk only releases the owning worker’s PROCESSING claim', () => {
    const id = batchId('release');
    createBatch(id, 2, parcels(2), 'anonymous', 2);

    expect(db.claimChunk(id, 0, 'worker-A', 60000)).not.toBeNull();
    expect(db.releaseChunk(id, 0, 'worker-B')).toBe(false);
    expect(getChunk(id, 0).status).toBe('PROCESSING');
    expect(db.releaseChunk(id, 0, 'worker-A')).toBe(true);
    expect(getChunk(id, 0).status).toBe('PENDING');
  });
});
