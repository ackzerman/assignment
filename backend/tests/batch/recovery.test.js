/**
 * Startup orphan recovery: QUEUED batches with no queue job (crash between
 * state creation and enqueue) are re-enqueued exactly when safe.
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');
const {
  recoverOrphanedBatches,
  DEFAULT_RECOVERY_GRACE_MS,
} = require('../../src/infrastructure/recovery');

const NOW = 1_700_000_000_000;
const OLD = new Date(NOW - DEFAULT_RECOVERY_GRACE_MS - 60_000).toISOString();

function fakeStore(states) {
  return {
    listBatchIds: async () => Object.keys(states),
    getBatchState: async (id) => states[id] || null,
  };
}

function fakeQueue({ jobs = {}, added = [] } = {}) {
  return {
    getBatchJob: async (id) => jobs[id] || null,
    addBatchJob: async (id) => {
      added.push(id);
      jobs[id] = { id: `batch-${id}` };
      return jobs[id];
    },
  };
}

const silentLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('Orphan batch recovery', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('re-enqueues an old QUEUED batch with no job', async () => {
    const states = {
      'BATCH-old': { status: 'QUEUED', createdAt: OLD },
    };
    const queue = fakeQueue();
    const summary = await recoverOrphanedBatches({
      now: NOW,
      batchStore: fakeStore(states),
      queueModule: queue,
      log: silentLog,
    });
    expect(summary).toEqual({ checked: 1, recovered: 1, skipped: 0 });
  });

  it('skips batches that already have a queue job', async () => {
    const states = { 'BATCH-has-job': { status: 'QUEUED', createdAt: OLD } };
    const queue = fakeQueue({ jobs: { 'BATCH-has-job': { id: 'batch-BATCH-has-job' } } });
    const added = [];
    const origAdd = queue.addBatchJob;
    queue.addBatchJob = async (id) => { added.push(id); return origAdd(id); };
    const summary = await recoverOrphanedBatches({
      now: NOW,
      batchStore: fakeStore(states),
      queueModule: queue,
      log: silentLog,
    });
    expect(summary).toEqual({ checked: 1, recovered: 0, skipped: 1 });
    expect(added).toHaveLength(0);
  });

  it('skips non-QUEUED batches (PROCESSING/COMPLETED/FAILED untouched)', async () => {
    const states = {
      'BATCH-proc': { status: 'PROCESSING', createdAt: OLD },
      'BATCH-done': { status: 'COMPLETED', createdAt: OLD },
      'BATCH-fail': { status: 'FAILED', createdAt: OLD },
    };
    const added = [];
    const queue = fakeQueue();
    const origAdd = queue.addBatchJob;
    queue.addBatchJob = async (id) => { added.push(id); return origAdd(id); };
    const summary = await recoverOrphanedBatches({
      now: NOW,
      batchStore: fakeStore(states),
      queueModule: queue,
      log: silentLog,
    });
    expect(summary).toEqual({ checked: 3, recovered: 0, skipped: 3 });
    expect(added).toHaveLength(0);
  });

  it('skips freshly-created QUEUED batches within the grace period', async () => {
    const states = {
      'BATCH-fresh': { status: 'QUEUED', createdAt: new Date(NOW - 1000).toISOString() },
    };
    const added = [];
    const queue = fakeQueue();
    const origAdd = queue.addBatchJob;
    queue.addBatchJob = async (id) => { added.push(id); return origAdd(id); };
    const summary = await recoverOrphanedBatches({
      now: NOW,
      batchStore: fakeStore(states),
      queueModule: queue,
      log: silentLog,
    });
    expect(summary).toEqual({ checked: 1, recovered: 0, skipped: 1 });
    expect(added).toHaveLength(0);
  });

  it('recovers end-to-end against Redis state with a stubbed queue', async () => {
    redis.setRedisImplementation(RedisMock);
    try {
      const parcels = [{ weight: 1, value: 10, destinationCountry: 'DE', parcelId: 'P1' }];
      await store.createBatchState('BATCH-e2e-orphan', parcels, 10);
      // Backdate past the grace period to simulate a pre-crash batch.
      const client = await redis.getRedisClient();
      const stateBefore = await store.getBatchState('BATCH-e2e-orphan');
      expect(stateBefore.status).toBe('QUEUED');

      const added = [];
      const summary = await recoverOrphanedBatches({
        graceMs: 0,
        batchStore: store,
        queueModule: {
          getBatchJob: async () => null,
          addBatchJob: async (id) => { added.push(id); return { id: `batch-${id}` }; },
        },
        log: silentLog,
      });
      expect(added).toEqual(['BATCH-e2e-orphan']);
      expect(summary.recovered).toBe(1);
      await client.del(
        'batch:BATCH-e2e-orphan:meta',
        'batch:BATCH-e2e-orphan:input',
        'batch:BATCH-e2e-orphan:chunks',
        'batch:BATCH-e2e-orphan:results',
      );
    } finally {
      await redis.closeRedis();
    }
  });
});
