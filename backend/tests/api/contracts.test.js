/**
 * API contract tests (Master Phase: API contracts).
 *
 * Canonical endpoints:
 *   POST /api/parcels → 200 + explainable result
 *   POST /api/batches → 202 + batchId/QUEUED
 *   GET  /api/batches/:id → status/progress
 *   GET  /api/batches/:id/results → persisted results
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

const {
  initDatabase,
  closeDatabase,
} = require('../../src/infrastructure/database');

let app;

describe('API contracts', () => {
  beforeAll(() => {
    initDatabase(':memory:');
    app = require('../../src/app');
  });

  afterAll(() => {
    closeDatabase();
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

  it('POST /api/batches returns 202 with batchId and QUEUED status', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });

    expect(res.status).toBe(202);
    expect(res.body.data.batchId).toMatch(/^BATCH-/);
    expect(res.body.data.status).toBe('QUEUED');
  });

  it('GET /api/batches/:id reflects DB durable state', async () => {
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

  it('exposes retry config as exponential backoff with max attempts', () => {
    const { JOB_RETRY_CONFIG } = require('../../src/infrastructure/queue');
    expect(JOB_RETRY_CONFIG.attempts).toBe(3);
    expect(JOB_RETRY_CONFIG.backoff.type).toBe('exponential');
    expect(JOB_RETRY_CONFIG.backoff.delay).toBeGreaterThanOrEqual(1000);
  });
});
