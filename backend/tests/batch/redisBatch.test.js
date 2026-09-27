/**
 * Redis batch processing tests: chunk checkpointing, recovery, idempotency,
 * worker error semantics, and progress accounting.
 *
 * State is temporary Redis state (ioredis-mock here, real Redis in prod).
 * Crash/recovery is simulated through failure injection (mocked checkpoint
 * failures and expired leases), not real process crashes.
 *
 * Key guarantees under test:
 * - DONE chunks are never reprocessed; retries skip checkpointed work
 * - Parcel-level HSETNX idempotency: no duplicate authoritative results
 * - Progress derives from checkpoint state (no double counting on retry)
 * - EXPECTED validation failures continue; UNEXPECTED errors propagate
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob, processOneParcel } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-${prefix}-${Date.now()}-${seq}`;
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

function mockJob(id) {
  return { id, data: {}, updateProgress: jest.fn(async () => {}) };
}

async function createBatch(prefix, list, chunkSize = 2) {
  const id = batchId(prefix);
  await store.createBatchState(id, list, chunkSize);
  return id;
}

describe('Redis batch processing', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
  });

  afterAll(async () => {
    await redis.closeRedis();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- Chunk checkpoints ---

  it('creates PENDING chunk checkpoints at batch creation', async () => {
    const id = await createBatch('create', parcels(5), 2);
    const chunks = await store.getChunks(id);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect(chunks[0]).toMatchObject({ startIndex: 0, endIndex: 2, parcelCount: 2 });
    expect(chunks[2]).toMatchObject({ startIndex: 4, endIndex: 5, parcelCount: 1 });
  });

  it('a worker can atomically claim a PENDING chunk', async () => {
    const id = await createBatch('claim', parcels(4), 2);
    const claimed = await store.claimChunk(id, 0, 'worker-A', 60000);
    expect(claimed).not.toBeNull();
    expect(claimed.status).toBe('PROCESSING');
    expect(claimed.workerId).toBe('worker-A');
    expect((await store.getChunk(id, 0)).status).toBe('PROCESSING');
  });

  it('two workers cannot claim the same chunk', async () => {
    const id = await createBatch('race', parcels(4), 2);
    expect(await store.claimChunk(id, 0, 'worker-A', 60000)).not.toBeNull();
    expect(await store.claimChunk(id, 0, 'worker-B', 60000)).toBeNull();
    expect((await store.getChunk(id, 0)).workerId).toBe('worker-A');
  });

  it('multiple workers can claim different chunks of the same batch', async () => {
    const id = await createBatch('parallel', parcels(4), 2);
    const a = await store.claimNextChunk(id, 'worker-A', 60000);
    const b = await store.claimNextChunk(id, 'worker-B', 60000);
    expect(a.chunkIndex).toBe(0);
    expect(b.chunkIndex).toBe(1);
  });

  it('a stale PROCESSING chunk (expired lock) can be reclaimed', async () => {
    const id = await createBatch('stale', parcels(2), 2);
    expect(await store.claimChunk(id, 0, 'crashed-worker', 40)).not.toBeNull();
    await new Promise((res) => setTimeout(res, 80));
    const recovered = await store.claimNextChunk(id, 'worker-B', 60000);
    expect(recovered).not.toBeNull();
    expect(recovered.chunkIndex).toBe(0);
    expect(recovered.workerId).toBe('worker-B');
  });

  it('a live PROCESSING chunk cannot be stolen', async () => {
    const id = await createBatch('live', parcels(2), 2);
    expect(await store.claimChunk(id, 0, 'worker-A', 60000)).not.toBeNull();
    expect(await store.claimChunk(id, 0, 'worker-B', 60000)).toBeNull();
    expect(await store.claimNextChunk(id, 'worker-B', 60000)).toBeNull();
  });

  it('releaseChunk only releases the owning worker’s claim', async () => {
    const id = await createBatch('release', parcels(2), 2);
    expect(await store.claimChunk(id, 0, 'worker-A', 60000)).not.toBeNull();
    expect(await store.releaseChunk(id, 0, 'worker-B')).toBe(false);
    expect((await store.getChunk(id, 0)).status).toBe('PROCESSING');
    expect(await store.releaseChunk(id, 0, 'worker-A')).toBe(true);
    expect((await store.getChunk(id, 0)).status).toBe('PENDING');
  });

  // --- Worker end-to-end (mock job, Redis state) ---

  it('processes a batch to COMPLETED with correct progress', async () => {
    const id = await createBatch('done', parcels(4), 2);
    const job = mockJob('job-done');
    job.data = { batchId: id };

    const summary = await processBatchJob(job);
    expect(summary).toMatchObject({ batchId: id, status: 'COMPLETED', total: 4, successful: 4, failed: 0 });

    const state = await store.getBatchState(id);
    expect(state.status).toBe('COMPLETED');
    expect(state.processed).toBe(4);
    expect(state.progress).toBe(100);
    expect(state.completedChunks).toBe(2);
    expect(await store.getBatchResultCount(id)).toBe(4);
    expect(job.updateProgress).toHaveBeenLastCalledWith(100);
  });

  it('records invalid parcels and finalizes COMPLETED_WITH_ERRORS', async () => {
    const id = await createBatch('mixed', [
      { weight: 0.5, value: 10, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 10, destinationCountry: 'DE', parcelId: 'P2' },
      { weight: 15, value: 6000, destinationCountry: 'US', parcelId: 'P3' },
    ], 2);
    const job = mockJob('job-mixed');
    job.data = { batchId: id };

    const summary = await processBatchJob(job);
    expect(summary.status).toBe('COMPLETED_WITH_ERRORS');
    expect(summary.successful).toBe(2);
    expect(summary.failed).toBe(1);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED_WITH_ERRORS');
  });

  it('is deterministic: same input → same routing result', () => {
    const parcel = { weight: 5, value: 2000, destinationCountry: 'DE' };
    const a = processOneParcel('B1', 'P1', parcel, 0);
    const b = processOneParcel('B1', 'P1', parcel, 0);
    expect(a).toEqual(b);
    expect(a.matchedRules).toContain('department.regular');
    expect(a.matchedRules).toContain('approval.insurance');
  });

  // --- Retry / recovery ---

  it('a retry skips DONE chunks and creates no duplicates', async () => {
    const id = await createBatch('retry', parcels(4), 2);
    const first = mockJob('job-first');
    first.data = { batchId: id };
    await processBatchJob(first);
    expect(await store.getBatchResultCount(id)).toBe(4);

    const second = mockJob('job-retry');
    second.data = { batchId: id };
    const summary = await processBatchJob(second);
    expect(summary.status).toBe('COMPLETED');
    expect(await store.getBatchResultCount(id)).toBe(4);
    expect((await store.getChunks(id)).every((c) => c.status === 'DONE')).toBe(true);
  });

  it('a crash mid-batch does not restart completed chunks and does not double-count progress', async () => {
    const id = await createBatch('crash', parcels(4), 2);

    const real = store.checkpointChunk.bind(store);
    let crashed = false;
    jest.spyOn(store, 'checkpointChunk').mockImplementation((bId, chunkIndex, ...rest) => {
      if (chunkIndex === 1 && !crashed) {
        crashed = true;
        throw new Error('simulated worker crash before checkpoint');
      }
      return real(bId, chunkIndex, ...rest);
    });

    const job = mockJob('job-crash');
    job.data = { batchId: id };
    await expect(processBatchJob(job, { leaseMs: 0 })).rejects.toThrow('simulated worker crash');

    expect((await store.getChunk(id, 0)).status).toBe('DONE');
    expect((await store.getChunk(id, 1)).status).not.toBe('DONE');
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');

    const retry = mockJob('job-retry2');
    retry.data = { batchId: id };
    const summary = await processBatchJob(retry, { leaseMs: 0 });
    expect(summary.status).toBe('COMPLETED');
    expect(summary.successful).toBe(4);

    const state = await store.getBatchState(id);
    expect(state.processed).toBe(4);
    expect(state.progress).toBe(100);
    expect(await store.getBatchResultCount(id)).toBe(4);
  });

  it('a chunk is marked DONE only after its results are checkpointed', async () => {
    const id = await createBatch('done-gate', parcels(2), 2);
    jest.spyOn(store, 'checkpointChunk').mockImplementation(() => {
      throw new Error('redis down');
    });

    const job = mockJob('job-gate');
    job.data = { batchId: id };
    await expect(processBatchJob(job, { leaseMs: 0 })).rejects.toThrow('redis down');

    expect((await store.getChunk(id, 0)).status).not.toBe('DONE');
    expect(await store.getBatchResultCount(id)).toBe(0);
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');
  });

  it('re-checkpointing a chunk absorbs duplicates via HSETNX idempotency', async () => {
    const id = await createBatch('nodup', parcels(2), 2);
    const chunk = await store.claimNextChunk(id, 'worker-A', 60000);
    const results = [
      processOneParcel(id, 'P1', parcels(2)[0], 0),
      processOneParcel(id, 'P2', parcels(2)[1], 1),
    ];
    const first = await store.checkpointChunk(id, chunk.chunkIndex, results, 2, 0);
    expect(first).toEqual({ inserted: 2, duplicates: 0 });
    const second = await store.checkpointChunk(id, chunk.chunkIndex, results, 2, 0);
    expect(second).toEqual({ inserted: 0, duplicates: 2 });
    expect(await store.getBatchResultCount(id)).toBe(2);
  });

  // --- Error semantics ---

  it('unexpected checkpoint failure propagates, records a system error, and leaves no parcel error rows', async () => {
    resetMetrics();
    const id = await createBatch('propagate', parcels(4), 2);
    jest.spyOn(store, 'checkpointChunk').mockImplementationOnce(() => {
      throw new Error('redis down');
    });

    const job = mockJob('job-unexpected');
    job.data = { batchId: id };
    await expect(processBatchJob(job, { leaseMs: 0 })).rejects.toThrow('redis down');

    expect(getMetrics().errors).toBe(1);
    expect((await store.getChunk(id, 0)).status).toBe('PENDING');
    expect(await store.getBatchResultCount(id)).toBe(0);
    const rows = await store.getBatchResults(id, {});
    expect(rows.filter((r) => r.status === 'error')).toHaveLength(0);
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');

    const retry = mockJob('job-retry3');
    retry.data = { batchId: id };
    const summary = await processBatchJob(retry, { leaseMs: 0 });
    expect(summary.status).toBe('COMPLETED');
    expect(await store.getBatchResultCount(id)).toBe(4);
  });

  it('partial validation failures do not fail the batch', async () => {
    const id = await createBatch('partial', [
      { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 100, destinationCountry: 'DE', parcelId: 'P2' },
    ], 2);
    const job = mockJob('job-partial');
    job.data = { batchId: id };
    const summary = await processBatchJob(job);
    expect(summary.status).toBe('COMPLETED_WITH_ERRORS');
    expect((await store.getChunks(id)).every((c) => c.status === 'DONE')).toBe(true);
    expect(await store.getBatchResultCount(id)).toBe(2);
  });

  // --- Progress ---

  it('batch progress reflects completed checkpoints', async () => {
    const id = await createBatch('progress', parcels(4), 2);
    const chunk = await store.claimNextChunk(id, 'worker-A', 60000);
    const data = parcels(4);
    const results = [];
    for (let index = chunk.startIndex; index < chunk.endIndex; index++) {
      results.push(processOneParcel(id, `P${index + 1}`, data[index], index));
    }
    await store.checkpointChunk(id, chunk.chunkIndex, results, 2, 0);

    const state = await store.getBatchState(id);
    expect(state.processed).toBe(2);
    expect(state.progress).toBe(50);
    expect(state.totalChunks).toBe(2);
    expect(state.completedChunks).toBe(1);
  });

  // --- Utilization metric ---

  it('counts concurrent worker jobs correctly', async () => {
    const { workerJobStarted, workerJobFinished } = require('../../src/observability/metrics');
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
});
