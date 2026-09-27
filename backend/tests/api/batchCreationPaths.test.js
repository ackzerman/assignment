/**
 * Batch creation paths: legacy alias behavior + queue-failure window.
 *
 * - POST /api/parcels/batch is an async alias of POST /api/batches (202).
 * - DB success + queue failure marks the batch FAILED (never falsely QUEUED)
 *   and returns 503.
 */

jest.mock('../../src/infrastructure/queue', () => {
  const actual = jest.requireActual('../../src/infrastructure/queue');
  return {
    ...actual,
    addBatchJob: jest.fn(async (batchId) => ({ id: `mock-${batchId}`, batchId })),
    getQueueHealth: jest.fn(async () => ({ connected: false, error: 'mock: no redis in tests' })),
  };
});

const request = require('supertest');
const queue = require('../../src/infrastructure/queue');
const {
  initDatabase,
  closeDatabase,
  getBatch,
} = require('../../src/infrastructure/database');

let app;

describe('Batch creation paths', () => {
  beforeAll(() => {
    initDatabase(':memory:');
    app = require('../../src/app');
  });

  afterAll(() => {
    closeDatabase();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const actualAdd = async (batchId) => ({ id: `mock-${batchId}`, batchId });
    queue.addBatchJob.mockImplementation(actualAdd);
    queue.getQueueHealth.mockResolvedValue({ connected: false, error: 'mock' });
  });

  it('legacy POST /api/parcels/batch is an async alias returning 202', async () => {
    const res = await request(app)
      .post('/api/parcels/batch')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.data.batchId).toMatch(/^BATCH-/);
    expect(res.body.data.status).toBe('QUEUED');

    const batch = getBatch(res.body.data.batchId);
    expect(batch).not.toBeNull();
    expect(batch.total).toBe(1);
  });

  it('legacy alias rejects duplicate parcel IDs like the canonical path', async () => {
    const res = await request(app)
      .post('/api/parcels/batch')
      .send({
        parcels: [
          { weight: 1, value: 10, destinationCountry: 'DE', parcelId: 'P1' },
          { weight: 2, value: 20, destinationCountry: 'DE', parcelId: 'P1' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Duplicate parcelId');
  });

  it('queue failure after DB creation marks the batch FAILED and returns 503', async () => {
    queue.addBatchJob.mockRejectedValueOnce(new Error('redis down'));

    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(503);

    // The batch must not be left falsely QUEUED.
    const { listBatches } = require('../../src/infrastructure/database');
    const failed = listBatches({ status: 'FAILED', limit: 10 });
    expect(failed.length).toBeGreaterThan(0);
    const batch = getBatch(failed[0].batchId);
    expect(batch.error).toContain('Queue submission failed');
  });
});
