/**
 * Backpressure test (Master: incoming rate vs worker rate, refuse when piled up).
 */

jest.mock('../../src/infrastructure/queue', () => {
  const actual = jest.requireActual('../../src/infrastructure/queue');
  return {
    ...actual,
    addBatchJob: jest.fn(async (batchId) => ({ id: `mock-${batchId}` })),
    getQueueHealth: jest.fn(async () => ({ connected: true, depth: 1000000 })),
  };
});

const request = require('supertest');
const { initDatabase, closeDatabase } = require('../../src/infrastructure/database');

describe('Backpressure', () => {
  let app;

  beforeAll(() => {
    initDatabase(':memory:');
    app = require('../../src/app');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('returns 429 with Retry-After when queue depth exceeds max', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
