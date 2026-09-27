/**
 * Backpressure test: refuse when durable work piles up.
 */

jest.mock('../../src/infrastructure/queue', () => {
  const actual = jest.requireActual('../../src/infrastructure/queue');
  return {
    ...actual,
    addBatchJob: jest.fn(async (batchId) => ({ id: `mock-${batchId}` })),
    getQueueHealth: jest.fn(async () => ({ connected: true, depth: 1000000 })),
  };
});

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const request = require('supertest');

describe('Backpressure', () => {
  let app;

  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('returns 429 with Retry-After when queue depth exceeds max', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
