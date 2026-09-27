/**
 * Batch creation paths: canonical creation + Redis/queue failure window.
 *
 * - POST /api/batches validates, creates temporary Redis state, enqueues.
 * - Redis down → 503 before anything is created.
 * - Queue failure after state creation → temporary state is deleted
 *   (never a falsely QUEUED batch) and the API returns 503.
 */

jest.mock('../../src/infrastructure/queue', () => {
  const actual = jest.requireActual('../../src/infrastructure/queue');
  return {
    ...actual,
    addBatchJob: jest.fn(async (batchId) => ({ id: `mock-${batchId}`, batchId })),
    getQueueHealth: jest.fn(async () => ({ connected: false, error: 'mock: no redis in tests' })),
  };
});

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const request = require('supertest');
const queue = require('../../src/infrastructure/queue');
const store = require('../../src/infrastructure/batchStore');

let app;

describe('Batch creation paths', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const actualAdd = async (batchId) => ({ id: `mock-${batchId}`, batchId });
    queue.addBatchJob.mockImplementation(actualAdd);
    queue.getQueueHealth.mockResolvedValue({ connected: false, error: 'mock' });
  });

  it('canonical POST /api/batches creates Redis state and returns 202', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');

    const batch = await store.getBatchState(res.body.data.batchId);
    expect(batch).not.toBeNull();
    expect(batch.total).toBe(1);
    expect(batch.status).toBe('QUEUED');
  });

  it('rejects duplicate parcel IDs like before', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        parcels: [
          { weight: 1, value: 10, destinationCountry: 'DE', parcelId: 'P1' },
          { weight: 2, value: 20, destinationCountry: 'DE', parcelId: 'P1' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Duplicate parcelId');
  });

  it('queue failure after state creation deletes state and returns 503', async () => {
    queue.addBatchJob.mockRejectedValueOnce(new Error('redis down'));
    const deleted = [];
    const realDelete = store.deleteBatch.bind(store);
    jest.spyOn(store, 'deleteBatch').mockImplementation(async (batchId) => {
      deleted.push(batchId);
      return realDelete(batchId);
    });

    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(503);
    // Temporary state was cleaned up: no falsely QUEUED batch lingers.
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^BATCH-/);
    expect(await store.getBatchState(deleted[0])).toBeNull();
  });

  it('Redis down fails fast with 503 before creating state', async () => {
    const redisModule = require('../../src/infrastructure/redis');
    jest.spyOn(redisModule, 'pingRedis').mockResolvedValue(false);

    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(503);
  });

  it('deleted temporary state reads as unknown (404)', async () => {
    const created = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    const batchId = created.body.data.batchId;
    await store.deleteBatch(batchId);

    const res = await request(app).get(`/api/batches/${batchId}`);
    expect(res.status).toBe(404);
  });
});
