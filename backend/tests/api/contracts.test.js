/**
 * API contract tests.
 *
 * Canonical endpoints:
 *   POST /api/parcels → 200 + explainable result
 *   POST /api/batches → 202 + full-UUID batchId/QUEUED
 *   GET  /api/batches/:id → status/progress from temporary Redis state
 *   GET  /api/batches/:id/results → paginated results
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

describe('API contracts', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('POST /api/parcels returns master explainable shape', async () => {
    const res = await request(app)
      .post('/api/parcels')
      .send({ weight: 5, value: 2000, destinationCountry: 'DE' });

    expect(res.status).toBe(200);
    expect(res.body.data.parcelId).toBeDefined();
    expect(res.body.data.department).toBe('Regular');
    expect(res.body.data.approvals).toContain('Insurance');
    expect(res.body.data.matchedRules).toContain('department.regular');
    expect(res.body.data.matchedRules).toContain('approval.insurance');
    expect(res.body.data.reasons.length).toBeGreaterThan(0);
  });

  it('POST /api/batches returns 202 with a full-UUID batchId and QUEUED status', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(202);
    expect(res.body.data.batchId).toMatch(/^BATCH-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.body.data.status).toBe('QUEUED');
  });

  it('GET /api/batches/:id reflects temporary Redis state', async () => {
    const created = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    const batchId = created.body.data.batchId;
    const res = await request(app).get(`/api/batches/${batchId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.batchId).toBe(batchId);
    expect(res.body.data.total).toBe(1);
    expect(typeof res.body.data.progress).toBe('number');
  });

  it('GET /api/batches/:id/results paginates with limit/offset', async () => {
    const parcels = Array.from({ length: 5 }, (_, i) => ({
      weight: 1, value: 10, destinationCountry: 'DE', parcelId: `P${i + 1}`,
    }));
    const created = await request(app)
      .post('/api/batches')
      .send({ parcels });
    const batchId = created.body.data.batchId;

    // Drive the worker directly against Redis state (no live BullMQ here).
    const { processBatchJob } = require('../../src/infrastructure/worker');
    await processBatchJob({ id: 'job-contracts', data: { batchId }, updateProgress: async () => {} });

    const page1 = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=0`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.resultCount).toBe(5);
    expect(page1.body.data.results).toHaveLength(2);
    expect(page1.body.data.results[0].parcelId).toBe('P1');

    const page3 = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=4`);
    expect(page3.body.data.results).toHaveLength(1);
    expect(page3.body.data.results[0].parcelId).toBe('P5');
  });

  it('GET unknown/expired batch returns 404', async () => {
    const res = await request(app).get('/api/batches/BATCH-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('exposes retry config as exponential backoff with max attempts', () => {
    const { JOB_RETRY_CONFIG } = require('../../src/infrastructure/queue');
    expect(JOB_RETRY_CONFIG.attempts).toBe(3);
    expect(JOB_RETRY_CONFIG.backoff.type).toBe('exponential');
    expect(JOB_RETRY_CONFIG.backoff.delay).toBeGreaterThanOrEqual(1000);
  });
});
