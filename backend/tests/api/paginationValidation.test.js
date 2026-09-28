/**
 * Strict pagination query validation for GET /api/batches/:batchId/results.
 *
 * - missing → defaults (limit = RESULTS_MAX_LIMIT, offset = 0)
 * - "100" → 100; offset "0" valid; limit capped at max
 * - "0" (limit), "-1", "1.5", "100abc", "NaN", "" → 400, never reinterpreted
 * - pages: first / middle / last / beyond-end; stable ordering; capped limit
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
const store = require('../../src/infrastructure/batchStore');

let app;

async function seedBatch(id, n) {
  const parcels = Array.from({ length: n }, (_, i) => ({
    weight: 2,
    value: 100,
    destinationCountry: 'DE',
    parcelId: `P${i + 1}`,
  }));
  await store.createBatchState(id, parcels, n);
  // Mark every chunk DONE with empty results so getBatchResults has rows:
  // simpler to checkpoint directly with fabricated routed rows.
  const chunks = await store.getChunks(id);
  const workerId = 'seed';
  for (const chunk of chunks) {
    const claimed = await store.claimChunk(id, chunk.chunkIndex, workerId, 60000);
    const rows = [];
    for (let i = chunk.startIndex; i < chunk.endIndex; i++) {
      rows.push({ parcelId: `P${i + 1}`, index: i, status: 'routed', department: 'Regular' });
    }
    await store.checkpointChunk(id, chunk.chunkIndex, claimed.token, rows, rows.length, 0);
  }
  return id;
}

describe('Strict pagination validation', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
    app = require('../../src/app');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  describe('parsePaginationQuery unit semantics', () => {
    const { parsePaginationQuery } = store;
    const MAX = store.getResultsMaxLimit();

    it('missing params → defaults', () => {
      expect(parsePaginationQuery({})).toEqual({ limit: MAX, offset: 0 });
    });

    it('valid strict integers pass through', () => {
      expect(parsePaginationQuery({ limit: '100', offset: '0' })).toEqual({ limit: 100, offset: 0 });
      expect(parsePaginationQuery({ limit: '1', offset: '25' })).toEqual({ limit: 1, offset: 25 });
    });

    it('limit is capped at the max', () => {
      expect(parsePaginationQuery({ limit: String(MAX + 5000) }).limit).toBe(MAX);
    });

    it.each([
      ['0'], ['-1'], ['1.5'], ['100abc'], ['NaN'], [''], [' 100'], ['0x10'], ['1e2'],
    ])('limit %p → 400', (limit) => {
      expect(() => parsePaginationQuery({ limit })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it.each([
      ['-1'], ['1.5'], ['10abc'], ['NaN'], [''],
    ])('offset %p → 400', (offset) => {
      expect(() => parsePaginationQuery({ offset })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });
  });

  describe('GET results endpoint', () => {
    const batchId = 'BATCH-PAGE-STRICT-1';

    beforeAll(async () => {
      await seedBatch(batchId, 5);
    });

    it('first / middle / last / beyond-end pages are correct and ordered', async () => {
      const first = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=0`);
      expect(first.status).toBe(200);
      expect(first.body.data.results.map((r) => r.parcelId)).toEqual(['P1', 'P2']);
      expect(first.body.data.resultCount).toBe(5);

      const middle = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=2`);
      expect(middle.body.data.results.map((r) => r.parcelId)).toEqual(['P3', 'P4']);

      const last = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=4`);
      expect(last.body.data.results.map((r) => r.parcelId)).toEqual(['P5']);

      const beyond = await request(app).get(`/api/batches/${batchId}/results?limit=2&offset=10`);
      expect(beyond.status).toBe(200);
      expect(beyond.body.data.results).toEqual([]);
      expect(beyond.body.data.resultCount).toBe(5);
    });

    it.each([
      ['limit=100abc'], ['limit=1.5'], ['limit=-1'], ['limit=0'], ['limit=NaN'], ['limit='],
      ['offset=-1'], ['offset=1.5'], ['offset=abc'],
    ])('malformed query %p → 400', async (qs) => {
      const res = await request(app).get(`/api/batches/${batchId}/results?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('limit above the max is capped, not rejected', async () => {
      const res = await request(app).get(
        `/api/batches/${batchId}/results?limit=${store.getResultsMaxLimit() + 100}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.results).toHaveLength(5);
    });

    it('unknown/expired batch → 404', async () => {
      const res = await request(app).get('/api/batches/BATCH-nope/results?limit=10');
      expect(res.status).toBe(404);
    });
  });

  describe('getBatchResults direct-call validation (single strict path)', () => {
    const batchId = 'BATCH-PAGE-STRICT-1';

    it.each([['100abc'], ['1.5'], ['-1'], ['0'], ['NaN'], ['']])(
      'string limit %p → 400-style error, never reinterpreted',
      async (limit) => {
        await expect(store.getBatchResults(batchId, { limit })).rejects.toMatchObject({ statusCode: 400 });
      },
    );

    it.each([['-1'], ['1.5'], ['abc']])(
      'string offset %p → 400-style error',
      async (offset) => {
        await expect(store.getBatchResults(batchId, { offset })).rejects.toMatchObject({ statusCode: 400 });
      },
    );

    it('already-parsed numbers pass through identically', async () => {
      const rows = await store.getBatchResults(batchId, { limit: 2, offset: 1 });
      expect(rows.map((r) => r.parcelId)).toEqual(['P2', 'P3']);
    });
  });
});
