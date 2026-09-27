/**
 * Observability endpoint contracts:
 * - GET /health/live answers without dependencies.
 * - GET /health/ready reports dependency state honestly.
 * - GET /api/metrics exposes operational counters.
 * - GET /api/health/detailed exposes anomalyDetector shape.
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

describe('Observability endpoints', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('GET /health/live answers 200 with no dependency checks', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('GET /health/ready reports not_ready when the queue is down', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.redis.status).toBe('ok');
    expect(res.body.checks.queue.status).toBe('error');
  });

  it('GET /api/metrics exposes operational counters', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      parcelsProcessed: expect.any(Number),
      failedParcels: expect.any(Number),
      batchesProcessed: expect.any(Number),
      errors: expect.any(Number),
      httpRequests: expect.any(Number),
      jobsProcessed: expect.any(Number),
    });
    expect(res.body.data.distribution).toBeDefined();
  });

  it('GET /api/health/detailed exposes anomaly shape', async () => {
    const res = await request(app).get('/api/health/detailed');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.healthy).toBe('boolean');
    expect(Array.isArray(res.body.data.alerts)).toBe(true);
    expect(res.body.data.metrics).toBeDefined();
  });
});
