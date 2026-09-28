/**
 * Worker routing-engine failure test (unexpected error distinction).
 *
 * A routing-engine bug is UNEXPECTED: it must propagate to the queue/job
 * failure path (with a system error recorded and a safe client-facing
 * surface), never become an ordinary parcel-level row, and the batch must
 * stay recoverable.
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

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');

describe('Worker routing-engine failure', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('propagates engine bugs instead of storing parcel error rows', async () => {
    resetMetrics();
    const batchId = `BATCH-ENG-${Date.now()}`;
    await store.createBatchState(
      batchId,
      [
        { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
        { weight: 2, value: 777, destinationCountry: 'DE', parcelId: 'P2' },
      ],
      2,
    );

    const job = { id: 'job-engine', data: { batchId }, updateProgress: jest.fn(async () => {}) };
    await expect(processBatchJob(job, { leaseMs: 60000 })).rejects.toThrow('engine bug');

    // System error recorded (not a parcel failure), nothing stored as
    // an 'error' parcel row, claim released, batch left recoverable.
    expect(getMetrics().errors).toBe(1);
    const rows = await store.getBatchResults(batchId, {});
    expect(rows.filter((r) => r.status === 'error')).toHaveLength(0);
    expect(await store.getBatchResultCount(batchId)).toBe(0);
    expect((await store.getChunk(batchId, 0)).status).toBe('PENDING');
    expect((await store.getBatchState(batchId)).status).toBe('PROCESSING');
  });

  it('records a system error only when no retry remains (no retry-noise spike)', async () => {
    resetMetrics();
    const mkBatch = async (suffix) => {
      const batchId = `BATCH-ENG-RETRY-${suffix}-${Date.now()}`;
      await store.createBatchState(
        batchId,
        [
          { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
          { weight: 2, value: 777, destinationCountry: 'DE', parcelId: 'P2' },
        ],
        2,
      );
      return batchId;
    };

    // First attempt of 3: will be retried → no system error recorded.
    const batchA = await mkBatch('a');
    const firstTry = { id: 'job-retry-1', data: { batchId: batchA }, updateProgress: jest.fn(async () => {}), attemptsMade: 0, opts: { attempts: 3 } };
    await expect(processBatchJob(firstTry, { leaseMs: 60000 })).rejects.toThrow('engine bug');
    expect(getMetrics().errors).toBe(0);

    // Final attempt (attemptsMade 2 of 3): exhaustion → exactly one error.
    const batchB = await mkBatch('b');
    const lastTry = { id: 'job-retry-3', data: { batchId: batchB }, updateProgress: jest.fn(async () => {}), attemptsMade: 2, opts: { attempts: 3 } };
    await expect(processBatchJob(lastTry, { leaseMs: 60000 })).rejects.toThrow('engine bug');
    expect(getMetrics().errors).toBe(1);
  });
});
