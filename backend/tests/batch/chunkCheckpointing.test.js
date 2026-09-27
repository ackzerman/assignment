/**
 * Chunk-level checkpointing tests (targeted batch recovery improvement).
 *
 * Two durability layers under test:
 * - Chunk checkpoints (PENDING → PROCESSING → DONE) = recovery optimization.
 * - UNIQUE(batch_id, parcel_id) parcel idempotency = final correctness guard.
 *
 * Crash/recovery is simulated through failure injection (mocked persistence
 * failures and expired leases), not real process crashes.
 */

const db = require('../../src/infrastructure/database');
const {
  initDatabase,
  closeDatabase,
  createBatch,
  getBatch,
  getBatchResultCount,
  getBatchResults,
  saveParcelResult,
  getChunks,
  getChunk,
  getChunkProgress,
  claimChunk,
  claimNextChunk,
  persistChunkAndMarkDone,
} = db;
const { processBatchJob, processOneParcel } = require('../../src/infrastructure/worker');

let batchSeq = 0;
function nextBatchId(prefix) {
  batchSeq += 1;
  return `BATCH-CHK-${prefix}-${Date.now()}-${batchSeq}`;
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

function mockJob(batchId, id = `job-${Math.random().toString(36).slice(2)}`) {
  return {
    id,
    data: { batchId },
    updateProgress: jest.fn(async () => {}),
  };
}

describe('Chunk checkpointing', () => {
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

  it('creates PENDING chunk checkpoints at batch creation', () => {
    const batchId = nextBatchId('create');
    createBatch(batchId, 5, parcels(5), 'anonymous', 2);

    const chunks = getChunks(batchId);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect(chunks[0]).toMatchObject({ startIndex: 0, endIndex: 2, parcelCount: 2 });
    expect(chunks[2]).toMatchObject({ startIndex: 4, endIndex: 5, parcelCount: 1 });
  });

  it('a worker can atomically claim a PENDING chunk', () => {
    const batchId = nextBatchId('claim');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    const claimed = claimChunk(batchId, 0, 'worker-A', 60000);
    expect(claimed).not.toBeNull();
    expect(claimed.status).toBe('PROCESSING');
    expect(claimed.workerId).toBe('worker-A');
    expect(getChunk(batchId, 0).status).toBe('PROCESSING');
  });

  it('two workers cannot successfully claim the same chunk', () => {
    const batchId = nextBatchId('race');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    expect(claimChunk(batchId, 0, 'worker-A', 60000)).not.toBeNull();
    expect(claimChunk(batchId, 0, 'worker-B', 60000)).toBeNull();
    expect(getChunk(batchId, 0).workerId).toBe('worker-A');
  });

  it('multiple workers can claim different chunks of the same batch', () => {
    const batchId = nextBatchId('parallel');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    const a = claimNextChunk(batchId, 'worker-A', 60000);
    const b = claimNextChunk(batchId, 'worker-B', 60000);
    expect(a.chunkIndex).toBe(0);
    expect(b.chunkIndex).toBe(1);

    // Each worker processes its own chunk through the shared domain core,
    // then bulk-persists and checkpoints DONE.
    for (const chunk of [a, b]) {
      const results = [];
      let ok = 0;
      for (let index = chunk.startIndex; index < chunk.endIndex; index++) {
        const parcelData = parcels(4)[index];
        const r = processOneParcel(batchId, `P${index + 1}`, parcelData, index);
        results.push(r);
        if (r.status === 'routed') ok++;
      }
      persistChunkAndMarkDone(batchId, chunk.chunkIndex, results, ok, results.length - ok);
    }

    expect(getChunkProgress(batchId)).toEqual({ totalChunks: 2, completedChunks: 2 });
    expect(getBatchResultCount(batchId)).toBe(4);
  });

  it('a stale PROCESSING chunk (expired lease) can be recovered', () => {
    const batchId = nextBatchId('stale');
    createBatch(batchId, 2, parcels(2), 'anonymous', 2);

    // Crashed worker: claim with an immediately-expired lease.
    expect(claimChunk(batchId, 0, 'crashed-worker', 0)).not.toBeNull();
    expect(getChunk(batchId, 0).status).toBe('PROCESSING');

    // Another worker recovers it.
    const recovered = claimNextChunk(batchId, 'worker-B', 60000);
    expect(recovered).not.toBeNull();
    expect(recovered.chunkIndex).toBe(0);
    expect(recovered.workerId).toBe('worker-B');
  });

  it('a live PROCESSING chunk cannot be stolen', () => {
    const batchId = nextBatchId('live');
    createBatch(batchId, 2, parcels(2), 'anonymous', 2);

    expect(claimChunk(batchId, 0, 'worker-A', 60000)).not.toBeNull();
    expect(claimChunk(batchId, 0, 'worker-B', 60000)).toBeNull();
    expect(claimNextChunk(batchId, 'worker-B', 60000)).toBeNull();
  });

  it('a completed chunk is not processed again on retry (no duplicate results)', async () => {
    const batchId = nextBatchId('retry');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    const first = await processBatchJob(mockJob(batchId), 2, { leaseMs: 60000 });
    expect(first.status).toBe('COMPLETED');
    expect(getBatchResultCount(batchId)).toBe(4);

    // Queue redelivers the same job: DONE chunks are skipped.
    const second = await processBatchJob(mockJob(batchId, 'job-retry'), 2, { leaseMs: 60000 });
    expect(second.status).toBe('COMPLETED');
    expect(getBatchResultCount(batchId)).toBe(4);
    expect(getChunks(batchId).every((c) => c.status === 'DONE')).toBe(true);
  });

  it('a worker crash mid-batch does not restart completed chunks', async () => {
    const batchId = nextBatchId('crash');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    // Crash before chunk 1's checkpoint transaction commits.
    const real = db.persistChunkAndMarkDone.bind(db);
    let crashed = false;
    jest.spyOn(db, 'persistChunkAndMarkDone').mockImplementation((bId, chunkIndex, ...rest) => {
      if (chunkIndex === 1 && !crashed) {
        crashed = true;
        throw new Error('simulated worker crash before checkpoint');
      }
      return real(bId, chunkIndex, ...rest);
    });

    await expect(processBatchJob(mockJob(batchId), 2, { leaseMs: 0 })).rejects.toThrow(
      'simulated worker crash',
    );

    // Chunk 0 is DONE; chunk 1 was never checkpointed.
    expect(getChunk(batchId, 0).status).toBe('DONE');
    expect(getChunk(batchId, 1).status).not.toBe('DONE');
    expect(getBatch(batchId).status).toBe('PROCESSING');

    // Retry: chunk 0 skipped, chunk 1 recovered, batch completes.
    const summary = await processBatchJob(mockJob(batchId, 'job-retry'), 2, { leaseMs: 0 });
    expect(summary.status).toBe('COMPLETED');
    expect(summary.successful).toBe(4);
    expect(getBatchResultCount(batchId)).toBe(4);
    expect(getChunks(batchId).every((c) => c.status === 'DONE')).toBe(true);
  });

  it('a chunk is marked DONE only after its results are persisted', async () => {
    const batchId = nextBatchId('done-gate');
    createBatch(batchId, 2, parcels(2), 'anonymous', 2);

    jest.spyOn(db, 'persistChunkAndMarkDone').mockImplementation(() => {
      throw new Error('persistence unavailable');
    });

    await expect(processBatchJob(mockJob(batchId), 2, { leaseMs: 0 })).rejects.toThrow(
      'persistence unavailable',
    );
    expect(getChunk(batchId, 0).status).not.toBe('DONE');
    expect(getBatchResultCount(batchId)).toBe(0);
    expect(getBatch(batchId).status).toBe('PROCESSING');
  });

  it('a retried chunk does not create duplicate parcel results', async () => {
    const batchId = nextBatchId('nodup');
    createBatch(batchId, 2, parcels(2), 'anonymous', 2);

    // Partially persist chunk 0 outside the checkpoint (simulates a crash
    // mid-transaction), then let the worker reprocess the whole chunk.
    const partial = processOneParcel(batchId, 'P1', parcels(2)[0], 0);
    expect(saveParcelResult(partial)).toBe(true);

    const summary = await processBatchJob(mockJob(batchId), 2, { leaseMs: 0 });
    expect(summary.status).toBe('COMPLETED');
    expect(getBatchResultCount(batchId)).toBe(2);

    const ids = getBatchResults(batchId).map((r) => r.parcelId).sort();
    expect(ids).toEqual(['P1', 'P2']);
  });

  it('UNIQUE(batchId, parcelId) protection still works', () => {
    const batchId = nextBatchId('unique');
    createBatch(batchId, 1, parcels(1), 'anonymous', 2);

    const row = {
      batchId,
      parcelId: 'P1',
      index: 0,
      status: 'routed',
      department: 'Regular',
      approvals: [],
      matchedRules: ['department.regular'],
      reasons: ['ok'],
    };
    expect(saveParcelResult(row)).toBe(true);
    expect(saveParcelResult(row)).toBe(false);
    expect(getBatchResults(batchId)).toHaveLength(1);
  });

  it('batch progress reflects completed chunks', async () => {
    const batchId = nextBatchId('progress');
    createBatch(batchId, 4, parcels(4), 'anonymous', 2);

    const chunk = claimNextChunk(batchId, 'worker-A', 60000);
    const data = parcels(4);
    const results = [];
    for (let index = chunk.startIndex; index < chunk.endIndex; index++) {
      results.push(processOneParcel(batchId, `P${index + 1}`, data[index], index));
    }
    persistChunkAndMarkDone(batchId, chunk.chunkIndex, results, 2, 0);

    const batch = getBatch(batchId);
    expect(batch.processed).toBe(2);
    expect(batch.progress).toBe(50);
    expect(batch.totalChunks).toBe(2);
    expect(batch.completedChunks).toBe(1);
  });

  it('partial validation failures within a chunk do not fail the batch', async () => {
    const batchId = nextBatchId('partial');
    const mixed = [
      { weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 100, destinationCountry: 'DE', parcelId: 'P2' },
    ];
    createBatch(batchId, mixed.length, mixed, 'anonymous', 2);

    const summary = await processBatchJob(mockJob(batchId), 2, { leaseMs: 60000 });
    expect(summary.status).toBe('COMPLETED_WITH_ERRORS');
    expect(summary.successful).toBe(1);
    expect(summary.failed).toBe(1);
    expect(getChunks(batchId).every((c) => c.status === 'DONE')).toBe(true);
    expect(getBatchResultCount(batchId)).toBe(2);
  });
});
