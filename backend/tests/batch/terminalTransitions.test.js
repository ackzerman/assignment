/**
 * Terminal batch-state transitions + completion-metrics coordination.
 *
 * - tryMarkBatchFailed: QUEUED/PROCESSING → FAILED only; terminal states
 *   (COMPLETED, COMPLETED_WITH_ERRORS, FAILED) are never overwritten.
 * - tryFinalizeBatch: only the execution performing the transition owns
 *   completion accounting (recordBatch exactly once per batch).
 * - claimChunk records leaseExpiresAt ≈ now + leaseMs (not claim time).
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob, handleJobFailed } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-TERM-${prefix}-${Date.now()}-${seq}`;
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

async function createBatch(prefix, list, chunkSize = 2) {
  const id = batchId(prefix);
  await store.createBatchState(id, list, chunkSize);
  return id;
}

describe('Terminal batch-state transitions', () => {
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

  // --- Bug 3: guarded FAILED transitions ---

  it('PROCESSING → FAILED works', async () => {
    const id = await createBatch('p-fail', parcels(2));
    await store.setBatchStatus(id, 'PROCESSING', { startedAt: new Date().toISOString() });
    expect(await store.tryMarkBatchFailed(id, 'boom')).toBe(true);
    const state = await store.getBatchState(id);
    expect(state.status).toBe('FAILED');
    expect(state.error).toBe('boom');
    expect(state.completedAt).toBeTruthy();
  });

  it('QUEUED → FAILED works', async () => {
    const id = await createBatch('q-fail', parcels(2));
    expect(await store.tryMarkBatchFailed(id, 'boom')).toBe(true);
    expect((await store.getBatchState(id)).status).toBe('FAILED');
  });

  it('COMPLETED → FAILED is rejected', async () => {
    const id = await createBatch('c-fail', parcels(2));
    const job = mockJob('job-c', id);
    job.data = { batchId: id };
    await processBatchJob(job);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');

    expect(await store.tryMarkBatchFailed(id, 'stale failure')).toBe(false);
    const state = await store.getBatchState(id);
    expect(state.status).toBe('COMPLETED');
    expect(state.error).toBeNull();
  });

  it('COMPLETED_WITH_ERRORS → FAILED is rejected', async () => {
    const id = await createBatch('cwe-fail', [
      { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 100, destinationCountry: 'DE', parcelId: 'P2' },
    ]);
    const job = mockJob('job-cwe', id);
    job.data = { batchId: id };
    await processBatchJob(job);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED_WITH_ERRORS');

    expect(await store.tryMarkBatchFailed(id, 'stale failure')).toBe(false);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED_WITH_ERRORS');
  });

  it('stale/duplicate job failure cannot corrupt a completed batch', async () => {
    const id = await createBatch('stale-fail', parcels(2));
    const job = mockJob('job-done', id);
    job.data = { batchId: id };
    await processBatchJob(job);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');

    // A duplicate delivery exhausting "retries" afterwards must not touch it.
    handleJobFailed(
      { id: 'job-dup', data: { batchId: id }, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('Redis WRONGTYPE duplicate delivery'),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const state = await store.getBatchState(id);
    expect(state.status).toBe('COMPLETED');
    expect(state.error).toBeNull();
  });

  // --- Bug 4: completion metrics recorded exactly once ---

  it('normal batch records exactly one batch completion metric', async () => {
    const id = await createBatch('metric-once', parcels(4));
    const job = mockJob('job-m', id);
    job.data = { batchId: id };
    await processBatchJob(job);

    const m = getMetrics();
    expect(m.batchesProcessed).toBe(1);
    expect(m.batchFailures).toBe(0);
  });

  it('rerunning a completed batch job does not increment completion metrics', async () => {
    const id = await createBatch('metric-rerun', parcels(4));
    const first = mockJob('job-mr1', id);
    first.data = { batchId: id };
    await processBatchJob(first);
    expect(getMetrics().batchesProcessed).toBe(1);

    const second = mockJob('job-mr2', id);
    second.data = { batchId: id };
    const summary = await processBatchJob(second);
    expect(summary.status).toBe('COMPLETED');

    const m = getMetrics();
    expect(m.batchesProcessed).toBe(1);
    expect(m.parcelsProcessed).toBe(4);
  });

  it('completed-with-errors rerun does not increment completion metrics again', async () => {
    const id = await createBatch('metric-cwe', [
      { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 100, destinationCountry: 'DE', parcelId: 'P2' },
    ]);
    const first = mockJob('job-mc1', id);
    first.data = { batchId: id };
    await processBatchJob(first);
    expect(getMetrics().batchesProcessed).toBe(1);
    expect(getMetrics().batchFailures).toBe(1);

    const second = mockJob('job-mc2', id);
    second.data = { batchId: id };
    const summary = await processBatchJob(second);
    expect(summary.status).toBe('COMPLETED_WITH_ERRORS');

    const m = getMetrics();
    expect(m.batchesProcessed).toBe(1);
    expect(m.batchFailures).toBe(1);
    expect(m.parcelsProcessed).toBe(2);
  });

  // --- Bug 5: lease expiry metadata ---

  it('leaseExpiresAt is approximately now + leaseMs', async () => {
    const id = await createBatch('lease-meta', parcels(2));
    const before = Date.now();
    const claimed = await store.claimChunk(id, 0, 'worker-A', 60000);
    const after = Date.now();

    expect(claimed).not.toBeNull();
    expect(claimed.leaseExpiresAt).toBeGreaterThanOrEqual(before + 60000);
    expect(claimed.leaseExpiresAt).toBeLessThanOrEqual(after + 60000);
  });
});
