/**
 * Auth/ownership tests (Master Phase 11: authorization / object ownership).
 *
 * - Without API_TOKENS: open mode (backward compatible).
 * - With API_TOKENS: Bearer required; batches are owned; cross-owner reads → 403.
 */

jest.mock('../../src/infrastructure/queue', () => {
  const actual = jest.requireActual('../../src/infrastructure/queue');
  return {
    ...actual,
    addBatchJob: jest.fn(async (batchId) => ({ id: `mock-${batchId}` })),
    getQueueHealth: jest.fn(async () => ({ connected: false, error: 'mock' })),
  };
});

const request = require('supertest');
const { initDatabase, closeDatabase } = require('../../src/infrastructure/database');

describe('Batch auth and ownership', () => {
  let app;

  beforeAll(() => {
    initDatabase(':memory:');
    app = require('../../src/app');
  });

  afterAll(() => {
    closeDatabase();
    delete process.env.API_TOKENS;
  });

  afterEach(() => {
    delete process.env.API_TOKENS;
  });

  it('open mode: no token required when unconfigured', async () => {
    delete process.env.API_TOKENS;
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    expect(res.status).toBe(202);
  });

  it('enforces Bearer auth and per-owner isolation when configured', async () => {
    process.env.API_TOKENS = 'alice-token,bob-token';

    const noAuth = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    expect(noAuth.status).toBe(401);

    const alice = await request(app)
      .post('/api/batches')
      .set('Authorization', 'Bearer alice-token')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    expect(alice.status).toBe(202);
    const batchId = alice.body.data.batchId;

    const bobRead = await request(app)
      .get(`/api/batches/${batchId}`)
      .set('Authorization', 'Bearer bob-token');
    expect(bobRead.status).toBe(403);

    const aliceRead = await request(app)
      .get(`/api/batches/${batchId}`)
      .set('Authorization', 'Bearer alice-token');
    expect(aliceRead.status).toBe(200);

    const bobResults = await request(app)
      .get(`/api/batches/${batchId}/results`)
      .set('Authorization', 'Bearer bob-token');
    expect(bobResults.status).toBe(403);
  });
});
