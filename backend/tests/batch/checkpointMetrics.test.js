/**
 * Checkpoint-aware batch metrics (Bug #2 regression tests).
 *
 * Business metrics (parcel counts, failure counts, routing distribution)
 * must reflect COMMITTED checkpoint work only — never attempts, retries,
 * or stale/rejected checkpoints.
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-MET-${prefix}-${Date.now()}-${seq}`;
}

function parcels(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    parcelId: `P${i + 1}`,
    ...overrides,
  }));
}

function mockJob(id, idBatch) {
  return { id, data: { batchId: idBatch }, updateProgress: jest.fn(async () => {}) };
}

describe('Checkpoint-aware batch metrics', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
  });

  afterAll(async () => {
    await redis.closeRedis();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    resetMetrics();
    jest.restoreAllMocks();
  });

  it('successful chunks contribute business metrics exactly once', async () => {
    const id = batchId('once');
    await store.createBatchState(id, parcels(4), 2);

    await processBatchJob(mockJob('job-m1', id));

    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(4);
    expect(m.failedParcels).toBe(0);
    expect(m.routingOutcomes).toEqual({ Regular: 4 });
  });

  it('a rejected (stale) checkpoint records no business metrics', async () => {
    const id = batchId('stale-metric');
    await store.createBatchState(id, parcels(2), 2);

    // Simulate lost ownership on the only checkpoint: lock vanishes first.
    const real = store.checkpointChunk.bind(store);
    jest.spyOn(store, 'checkpointChunk').mockImplementationOnce(
      async (bId, idx, token, ...rest) => {
        const client = await redis.getRedisClient();
        await client.del(`batch:${bId}:lock:${idx}`);
        return real(bId, idx, token, ...rest);
      },
    );

    // The rejected attempt records nothing; the worker reclaims the same
    // chunk in-loop and commits it exactly once.
    const summary = await processBatchJob(mockJob('job-m2', id), { leaseMs: 60000 });
    expect(summary.status).toBe('COMPLETED');

    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(2);
    expect(m.failedParcels).toBe(0);
    expect(m.routingOutcomes).toEqual({ Regular: 2 });
  });

  it('chunks held by another live worker record no metrics for this execution', async () => {
    const id = batchId('held-metric');
    await store.createBatchState(id, parcels(4), 2);

    // Another live worker owns chunk 0: this execution can only do chunk 1.
    const external = await store.claimNextChunk(id, 'worker-X', 60000);
    expect(external.chunkIndex).toBe(0);

    const summary = await processBatchJob(mockJob('job-m2b', id), { leaseMs: 60000 });
    expect(summary.status).toBe('PROCESSING');
    expect(summary.completedChunks).toBe(1);

    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(2);
    expect(m.routingOutcomes).toEqual({ Regular: 2 });
  });

  it('retried chunks do not double-count authoritative metrics', async () => {
    const id = batchId('retry-metric');
    await store.createBatchState(id, parcels(4), 2);

    await processBatchJob(mockJob('job-m3a', id));
    expect(getMetrics().parcelsProcessed).toBe(4);

    // Full retry after completion: DONE chunks skipped, metrics untouched.
    await processBatchJob(mockJob('job-m3b', id));
    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(4);
    expect(m.routingOutcomes).toEqual({ Regular: 4 });
  });

  it('mixed batches count failures once, only for committed chunks', async () => {
    const id = batchId('mixed-metric');
    await store.createBatchState(
      id,
      [
        { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
        { weight: -5, value: 100, destinationCountry: 'DE', parcelId: 'P2' },
      ],
      2,
    );

    await processBatchJob(mockJob('job-m4', id));

    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(2);
    expect(m.failedParcels).toBe(1);
    expect(m.routingOutcomes).toEqual({ Regular: 1 });
  });
});
