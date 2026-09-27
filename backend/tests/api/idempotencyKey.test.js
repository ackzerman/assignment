/**
 * POST /api/batches Idempotency-Key behavior:
 * - same key + same body → original batch identity, no duplicate batch
 * - same key + different body → 409 conflict
 * - no key → independent batches (existing behavior)
 * - malformed keys → 400
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

const parcelsA = [{ weight: 1, value: 10, destinationCountry: 'DE' }];
const parcelsB = [{ weight: 2, value: 20, destinationCountry: 'FR' }];

describe('Batch idempotency key', () => {
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
    queue.addBatchJob.mockImplementation(async (batchId) => ({ id: `mock-${batchId}`, batchId }));
    queue.getQueueHealth.mockResolvedValue({ connected: false, error: 'mock' });
  });

  it('repeated request with same key returns the original batch without duplicating', async () => {
    const key = `test-key-${Date.now()}-a`;
    const first = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', key)
      .send({ parcels: parcelsA });
    expect(first.status).toBe(202);
    const batchId = first.body.data.batchId;

    const second = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', key)
      .send({ parcels: parcelsA });
    expect(second.status).toBe(202);
    expect(second.body.data.batchId).toBe(batchId);
    expect(second.body.data.deduplicated).toBe(true);

    // Exactly one batch was created and queued for the two requests.
    expect(queue.addBatchJob).toHaveBeenCalledTimes(1);
    expect((await store.getBatchState(batchId)).status).toBe('QUEUED');
  });

  it('conflicting payload with the same key is rejected with 409', async () => {
    const key = `test-key-${Date.now()}-b`;
    const first = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', key)
      .send({ parcels: parcelsA });
    expect(first.status).toBe(202);

    const conflict = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', key)
      .send({ parcels: parcelsB });
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toMatch(/different batch/);
  });

  it('independent requests without a key create independent batches', async () => {
    const first = await request(app).post('/api/batches').send({ parcels: parcelsA });
    const second = await request(app).post('/api/batches').send({ parcels: parcelsA });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data.batchId).not.toBe(first.body.data.batchId);
  });

  it('malformed keys are rejected with 400', async () => {
    const empty = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', '   ')
      .send({ parcels: parcelsA });
    expect(empty.status).toBe(400);

    const tooLong = await request(app)
      .post('/api/batches')
      .set('Idempotency-Key', 'k'.repeat(257))
      .send({ parcels: parcelsA });
    expect(tooLong.status).toBe(400);
  });
});
