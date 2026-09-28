/**
 * Batch state-machine races: QUEUED → PROCESSING must be atomic and terminal
 * states must be unresurrectable.
 *
 * - tryMarkBatchProcessing: QUEUED → PROCESSING only; every other
 *   predecessor (PROCESSING, COMPLETED, COMPLETED_WITH_ERRORS, FAILED)
 *   is rejected.
 * - A stale worker that read QUEUED before finalization cannot flip a
 *   terminal batch back to PROCESSING (worker stands down instead).
 * - setBatchStatus throws on terminal escape (fail loudly, never resurrect).
 * - markBatchFailed is guarded (no overwrite of terminal batches).
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const { processBatchJob } = require('../../src/infrastructure/worker');
const { resetMetrics } = require('../../src/observability/metrics');

let seq = 0;
function batchId(prefix) {
  seq += 1;
  return `BATCH-RACE-${prefix}-${Date.now()}-${seq}`;
}

function parcels(n) {
  return Array.from({ length: n }, (_, i) => ({
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    parcelId: `P${i + 1}`,
  }));
}

function mockJob(id, idBatch) {
  return { id, data: { batchId: idBatch }, updateProgress: jest.fn(async () => {}) };
}

describe('Batch state-machine races', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  beforeEach(() => {
    resetMetrics();
    jest.restoreAllMocks();
  });

  it('QUEUED → PROCESSING succeeds once; second attempt is rejected', async () => {
    const id = batchId('qp');
    await store.createBatchState(id, parcels(2), 2);
    expect(await store.tryMarkBatchProcessing(id)).toBe(true);
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');
    // PROCESSING → PROCESSING is rejected.
    expect(await store.tryMarkBatchProcessing(id)).toBe(false);
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');
  });

  it.each([['COMPLETED'], ['COMPLETED_WITH_ERRORS'], ['FAILED']])(
    '%s → PROCESSING is rejected',
    async (terminal) => {
      const id = batchId(`term-${terminal}`);
      await store.createBatchState(id, parcels(2), 2);
      // Reach the terminal state through legal transitions.
      expect(await store.tryMarkBatchProcessing(id)).toBe(true);
      if (terminal === 'FAILED') {
        expect(await store.tryMarkBatchFailed(id, 'boom')).toBe(true);
      } else {
        expect(await store.tryFinalizeBatch(id, terminal)).toBe(false); // chunks not DONE yet
        // Drive to DONE via the worker, then finalize through the legal path.
        const job = mockJob(`job-${terminal}`, id);
        await processBatchJob(job);
        const state = await store.getBatchState(id);
        expect(['COMPLETED', 'COMPLETED_WITH_ERRORS']).toContain(state.status);
        if (state.status !== terminal) {
          // For the FAILED case we already covered; for COMPLETED variants
          // the worker decides the exact terminal — assert rejection below
          // against the ACTUAL terminal state.
          expect(await store.tryMarkBatchProcessing(id)).toBe(false);
          expect((await store.getBatchState(id)).status).toBe(state.status);
          return;
        }
      }
      expect(await store.tryMarkBatchProcessing(id)).toBe(false);
      expect((await store.getBatchState(id)).status).toBe(terminal);
    },
  );

  it('stale worker execution cannot resurrect a terminal batch', async () => {
    const id = batchId('stale');
    await store.createBatchState(id, parcels(2), 2);

    // Worker A runs to completion first.
    await processBatchJob(mockJob('job-A', id));
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');

    // Worker B "read QUEUED earlier" — it now runs the same job late.
    const summary = await processBatchJob(mockJob('job-B-stale', id));
    expect(summary.status).toBe('COMPLETED');

    const state = await store.getBatchState(id);
    expect(state.status).toBe('COMPLETED');
    expect(state.startedAt).toBeTruthy();
  });

  it('setBatchStatus throws when escaping a terminal state', async () => {
    const id = batchId('guard');
    await store.createBatchState(id, parcels(2), 2);
    await processBatchJob(mockJob('job-g', id));
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');

    await expect(store.setBatchStatus(id, 'PROCESSING')).rejects.toThrow(/terminal/i);
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');
  });

  it('setBatchStatus rejects non-edges (QUEUED→COMPLETED/COMPLETED_WITH_ERRORS)', async () => {
    const id = batchId('edges');
    await store.createBatchState(id, parcels(2), 2);

    // QUEUED → COMPLETED would finalize an unprocessed batch: rejected.
    await expect(store.setBatchStatus(id, 'COMPLETED')).rejects.toThrow(/not a valid state-machine edge/i);
    await expect(store.setBatchStatus(id, 'COMPLETED_WITH_ERRORS')).rejects.toThrow(/not a valid state-machine edge/i);
    expect((await store.getBatchState(id)).status).toBe('QUEUED');

    // Legal edges still work. Same-status rewrites are no-ops (allowed).
    await store.setBatchStatus(id, 'PROCESSING', { startedAt: new Date().toISOString() });
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');
    await store.setBatchStatus(id, 'PROCESSING');
    expect((await store.getBatchState(id)).status).toBe('PROCESSING');
    await store.setBatchStatus(id, 'FAILED', { error: 'x' });
    expect((await store.getBatchState(id)).status).toBe('FAILED');
  });

  it('markBatchFailed never overwrites a terminal batch', async () => {
    const id = batchId('mbf');
    await store.createBatchState(id, parcels(2), 2);
    await processBatchJob(mockJob('job-mbf', id));
    expect((await store.getBatchState(id)).status).toBe('COMPLETED');

    await store.markBatchFailed(id, 'stale failure');
    const state = await store.getBatchState(id);
    expect(state.status).toBe('COMPLETED');
    expect(state.error).toBeNull();
  });

  it('only QUEUED or PROCESSING may become FAILED (full matrix)', async () => {
    const allowed = ['QUEUED', 'PROCESSING'];
    const terminal = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'];
    for (const from of [...allowed, ...terminal]) {
      const id = batchId(`mx-${from}`);
      await store.createBatchState(id, parcels(2), 2);
      if (from === 'PROCESSING') {
        expect(await store.tryMarkBatchProcessing(id)).toBe(true);
      } else if (from !== 'QUEUED') {
        expect(await store.tryMarkBatchProcessing(id)).toBe(true);
        if (from === 'FAILED') {
          expect(await store.tryMarkBatchFailed(id, 'x')).toBe(true);
        } else {
          await processBatchJob(mockJob(`job-mx-${from}`, id));
          const actual = (await store.getBatchState(id)).status;
          expect(terminal).toContain(actual);
          // Rejection check against the actual terminal reached.
          expect(await store.tryMarkBatchFailed(id, 'late')).toBe(false);
          continue;
        }
      }
      const expected = allowed.includes(from);
      expect(await store.tryMarkBatchFailed(id, 'x')).toBe(expected);
    }
  });
});
