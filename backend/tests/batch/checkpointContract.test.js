/**
 * Checkpoint contract + batch failure-path regression tests (code-only fixes).
 *
 * - Worker passes checkpointChunk(batchId, chunkIndex, token, results,
 *   successful, failed) positionally with the claim's ownership token.
 * - committed=false (lost ownership) is handled gracefully, not as success.
 * - Exhausted BullMQ retries mark the batch FAILED with a SAFE public
 *   message; raw internal errors stay in logs and never reach the API.
 */

const RedisMock = require('ioredis-mock');
const redisMod = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob, handleJobFailed } = require('../../src/infrastructure/worker');
const { resetMetrics, getMetrics } = require('../../src/observability/metrics');
const request = require('supertest');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-CT-${prefix}-${Date.now()}-${seq}`;
}

function parcels(n) {
  return Array.from({ length: n }, (_, i) => ({
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    parcelId: `P${i + 1}`,
  }));
}

function mockJob(id, batchId) {
  return { id, data: { batchId }, updateProgress: jest.fn(async () => {}) };
}

let app;

describe('Checkpoint contract + failure path', () => {
  beforeAll(() => {
    redisMod.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redisMod.closeRedis();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- 6A. Checkpoint arguments ---

  it('worker passes batchId, chunkIndex, ownership token, results, counts in order', async () => {
    const id = batchId('args');
    await store.createBatchState(id, parcels(4), 2);
    const spy = jest.spyOn(store, 'checkpointChunk');

    await processBatchJob(mockJob('job-args', id));

    expect(spy).toHaveBeenCalledTimes(2);
    const [bId, idx, token, results, ok, fail] = spy.mock.calls[0];
    expect(bId).toBe(id);
    expect(idx).toBe(0);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    expect(ok).toBe(2);
    expect(fail).toBe(0);

    // The token was genuinely consumed by the commit: reusing it is stale.
    const reuse = await store.checkpointChunk(id, 0, token, [], 0, 0);
    expect(reuse.committed).toBe(false);
    expect((await store.getChunk(id, 0)).status).toBe('DONE');
  });

  // --- 6B. Ownership ---

  it('valid owner checkpoint commits and records DONE with progress', async () => {
    const id = batchId('owner');
    await store.createBatchState(id, parcels(2), 2);
    const claimed = await store.claimNextChunk(id, 'worker-A', 60000);
    expect(claimed).not.toBeNull();

    const res = await store.checkpointChunk(
      id,
      0,
      claimed.token,
      [{ parcelId: 'P1', index: 0, status: 'routed', department: 'Regular' }],
      1,
      0,
    );
    expect(res).toEqual({ committed: true, inserted: 1, duplicates: 0 });
    expect((await store.getChunk(id, 0)).status).toBe('DONE');
    const state = await store.getBatchState(id);
    expect(state.processed).toBe(1);
    expect(state.successful).toBe(1);
  });

  // --- 6C. committed=false handled gracefully ---

  it('lost-ownership checkpoint is skipped, reclaimed, and still completes', async () => {
    const id = batchId('lost');
    await store.createBatchState(id, parcels(4), 2);
    const client = await redisMod.getRedisClient();

    // Simulate the lock vanishing (expiry) right before the first commit.
    const real = store.checkpointChunk.bind(store);
    jest.spyOn(store, 'checkpointChunk').mockImplementationOnce(
      async (bId, idx, token, ...rest) => {
        await client.del(`batch:${bId}:lock:${idx}`);
        return real(bId, idx, token, ...rest);
      },
    );

    const summary = await processBatchJob(mockJob('job-lost', id), { leaseMs: 60000 });
    expect(summary.status).toBe('COMPLETED');
    expect(summary.successful).toBe(4);
    expect(await store.getBatchResultCount(id)).toBe(4);
    expect((await store.getChunks(id)).every((c) => c.status === 'DONE')).toBe(true);
  });

  // --- 6D. Failure handling: retry counted, exhausted → safe FAILED ---

  it('non-terminal job failure counts a retry without marking FAILED', async () => {
    resetMetrics();
    const id = batchId('retry-count');
    await store.createBatchState(id, parcels(2), 2);

    handleJobFailed(
      { id: 'job-r1', data: { batchId: id }, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('Redis WRONGTYPE Operation against a key holding the wrong kind of value'),
    );

    expect(getMetrics().jobsRetried).toBe(1);
    expect(getMetrics().jobsFailed).toBe(0);
    const state = await store.getBatchState(id);
    expect(state.status).not.toBe('FAILED');
    expect(state.error).toBeNull();
  });

  it('exhausted retries mark FAILED with a safe message; raw text never exposed', async () => {
    resetMetrics();
    const id = batchId('failed-safe');
    await store.createBatchState(id, parcels(2), 2);
    const rawMessage = 'Redis WRONGTYPE Operation against a key holding the wrong kind at /app/src/x.js:42';

    handleJobFailed(
      { id: 'job-f1', data: { batchId: id }, attemptsMade: 3, opts: { attempts: 3 } },
      new Error(rawMessage),
    );
    // markBatchFailed is async: flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(getMetrics().jobsFailed).toBe(1);

    const res = await request(app).get(`/api/batches/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.error).toBe('Batch processing failed after 3 attempts.');
    expect(JSON.stringify(res.body)).not.toContain('WRONGTYPE');
    expect(JSON.stringify(res.body)).not.toContain('/app/src');
  });
});
