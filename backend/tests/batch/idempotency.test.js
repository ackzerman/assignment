/**
 * Batch idempotency + failure-handling tests (Master Phase 6/9).
 *
 * Queue gives at-least-once delivery: duplicate executions must not
 * corrupt final state. DB UNIQUE(batch_id, parcel_id) is authoritative.
 */

const {
  initDatabase,
  closeDatabase,
  createBatch,
  getBatch,
  getBatchResults,
  saveParcelResult,
  saveParcelResultsBatch,
} = require('../../src/infrastructure/database');
const { processBatchJob, processOneParcel } = require('../../src/infrastructure/worker');

describe('Batch idempotency', () => {
  beforeAll(() => {
    initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('ignores duplicate parcel results (INSERT OR IGNORE)', () => {
    const batchId = `BATCH-IDEMP-${Date.now()}`;
    createBatch(batchId, 1, [{ weight: 2, value: 100, destinationCountry: 'DE', parcelId: 'P1' }]);

    const result = {
      batchId,
      parcelId: 'P1',
      index: 0,
      status: 'routed',
      department: 'Regular',
      approvals: [],
      matchedRules: ['department.regular'],
      reasons: ['Weight ok'],
    };

    expect(saveParcelResult(result)).toBe(true);
    expect(saveParcelResult(result)).toBe(false); // duplicate
    expect(getBatchResults(batchId)).toHaveLength(1);
  });

  it('counts duplicates in batch inserts without corrupting state', () => {
    const batchId = `BATCH-DUP-${Date.now()}`;
    createBatch(batchId, 2, []);
    const rows = [
      { batchId, parcelId: 'P1', index: 0, status: 'routed', department: 'Mail' },
      { batchId, parcelId: 'P1', index: 0, status: 'routed', department: 'Mail' },
      { batchId, parcelId: 'P2', index: 1, status: 'invalid', errors: [] },
    ];
    const { inserted, duplicates } = saveParcelResultsBatch(rows);
    expect(inserted).toBe(2);
    expect(duplicates).toBe(1);
    expect(getBatchResults(batchId)).toHaveLength(2);
  });

  it('is deterministic: same input → same routing result', () => {
    const parcel = { weight: 5, value: 2000, destinationCountry: 'DE' };
    const a = processOneParcel('B1', 'P1', parcel, 0);
    const b = processOneParcel('B1', 'P1', parcel, 0);
    expect(a).toEqual(b);
    expect(a.matchedRules).toContain('department.regular');
    expect(a.matchedRules).toContain('approval.insurance');
  });

  it('processes mixed batches to COMPLETED_WITH_ERRORS without crashing', async () => {
    const batchId = `BATCH-MIX-${Date.now()}`;
    const parcels = [
      { weight: 0.5, value: 10, destinationCountry: 'DE', parcelId: 'P1' },
      { weight: -5, value: 10, destinationCountry: 'DE', parcelId: 'P2' },
      { weight: 15, value: 6000, destinationCountry: 'US', parcelId: 'P3' },
    ];
    createBatch(batchId, parcels.length, parcels);

    const progresses = [];
    const job = {
      id: 'job-test',
      data: { batchId },
      updateProgress: async (p) => { progresses.push(p); },
    };

    const summary = await processBatchJob(job, 2);
    expect(summary.total).toBe(3);
    expect(summary.successful).toBe(2);
    expect(summary.failed).toBe(1);
    expect(getBatch(batchId).status).toBe('COMPLETED_WITH_ERRORS');
    expect(progresses[progresses.length - 1]).toBe(100);
  });
});
