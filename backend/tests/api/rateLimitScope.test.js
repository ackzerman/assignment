/**
 * Rate-limit scope: strict batch-CREATION limiting must not throttle
 * legitimate GET status/results polling (Bug 1 regression tests).
 *
 * - POST /api/batches → strict 10-per-15min limiter still enforced.
 * - GET /api/batches/:batchId (polled ~1/sec by the UI) and
 *   GET /api/batches/:batchId/results → general limiter only.
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

let app;

describe('Rate-limit scope', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  const oneParcel = () => ({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

  // NOTE: both tests share this file's app instance (and its in-memory
  // limiter windows), so the polling test runs first with a single POST,
  // leaving the remaining creation budget for the limit test below.
  it('repeated GET polling is not subject to the batch-creation limit', async () => {
    const created = await request(app).post('/api/batches').send(oneParcel());
    expect(created.status).toBe(202);
    const batchId = created.body.data.batchId;

    // 15 polls ≈ a batch processing for 15s at 1 poll/sec: must all succeed.
    for (let i = 0; i < 15; i++) {
      const res = await request(app).get(`/api/batches/${batchId}`);
      expect(res.status).toBe(200);
    }
    const results = await request(app).get(`/api/batches/${batchId}/results`);
    expect(results.status).toBe(200);
  });

  it('POST /api/batches remains protected by the strict batch limit', async () => {
    // One creation already consumed above: 9 more succeed, the 11th 429s.
    for (let i = 0; i < 9; i++) {
      const res = await request(app).post('/api/batches').send(oneParcel());
      expect(res.status).toBe(202);
    }
    const limited = await request(app).post('/api/batches').send(oneParcel());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
