/**
 * Worker routing-engine failure test (unexpected error distinction).
 *
 * A routing-engine bug is UNEXPECTED: it must propagate to the queue/job
 * failure path (with a system error recorded), never become an ordinary
 * parcel-level row, and the batch must stay recoverable.
 */

jest.mock('../../src/domain/routingEngine', () => {
  const actual = jest.requireActual('../../src/domain/routingEngine');
  return {
    ...actual,
    routeParcel: jest.fn((parcel) => {
      if (parcel.value === 777) {
        throw new Error('engine bug');
      }
      return actual.routeParcel(parcel);
    }),
  };
});

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
const { processBatchJob } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');

describe('Worker routing-engine failure', () => {
  beforeAll(() => {
    initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('propagates engine bugs instead of storing parcel error rows', async () => {
    resetMetrics();
    const batchId = `BATCH-ENG-${Date.now()}`;
    createBatch(
      batchId,
      2,
      [
        { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
        { weight: 2, value: 777, destinationCountry: 'DE', parcelId: 'P2' },
      ],
      'anonymous',
      2,
    );

    const job = { id: 'job-engine', data: { batchId }, updateProgress: jest.fn(async () => {}) };
    await expect(processBatchJob(job, 2, { leaseMs: 0 })).rejects.toThrow('engine bug');

    // System error recorded (not a parcel failure), nothing persisted as
    // an 'error' parcel row, claim released, batch left recoverable.
    expect(getMetrics().errors).toBe(1);
    expect(getBatchResults(batchId).filter((r) => r.status === 'error')).toHaveLength(0);
    expect(getBatchResultCount(batchId)).toBe(0);
    expect(getChunk(batchId, 0).status).toBe('PENDING');
    expect(getBatch(batchId).status).toBe('PROCESSING');
  });
});
