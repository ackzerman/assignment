/**
 * Batch rate-limit configuration tests.
 *
 * - createBatchRateLimiter() reads RATE_LIMIT_WINDOW_MS / BATCH_RATE_LIMIT_MAX
 *   with secure fallbacks (never 0/unlimited/NaN from bad config).
 * - The strict limiter guards POST /api/batches only; GET polling uses the
 *   general limiter.
 * - No 15-minute waits: small windows/limits are configured per test, and
 *   each test loads a fresh app (fresh limiter state).
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
const request = require('supertest');
const { positiveIntOrDefault } = require('../../src/api/middleware/security');

const WINDOW_VAR = 'RATE_LIMIT_WINDOW_MS';
const MAX_VAR = 'BATCH_RATE_LIMIT_MAX';
const GENERAL_MAX_VAR = 'RATE_LIMIT_MAX';
const POLLING_MAX_VAR = 'POLLING_RATE_LIMIT_MAX';

let savedWindow;
let savedMax;
let savedGeneralMax;
let savedPollingMax;

function loadApp(env = {}) {
  jest.resetModules();
  delete process.env[WINDOW_VAR];
  delete process.env[MAX_VAR];
  delete process.env[GENERAL_MAX_VAR];
  delete process.env[POLLING_MAX_VAR];
  Object.assign(process.env, env);
  const freshRedis = require('../../src/infrastructure/redis');
  freshRedis.setRedisImplementation(RedisMock);
  const freshQueue = require('../../src/infrastructure/queue');
  freshQueue.addBatchJob.mockImplementation(async (batchId) => ({ id: `mock-${batchId}`, batchId }));
  freshQueue.getQueueHealth.mockResolvedValue({ connected: false, error: 'mock' });
  return require('../../src/app');
}

describe('Batch rate-limit configuration', () => {
  beforeAll(() => {
    savedWindow = process.env[WINDOW_VAR];
    savedMax = process.env[MAX_VAR];
    savedGeneralMax = process.env[GENERAL_MAX_VAR];
    savedPollingMax = process.env[POLLING_MAX_VAR];
  });

  afterEach(() => {
    if (savedWindow === undefined) delete process.env[WINDOW_VAR];
    else process.env[WINDOW_VAR] = savedWindow;
    if (savedMax === undefined) delete process.env[MAX_VAR];
    else process.env[MAX_VAR] = savedMax;
    if (savedGeneralMax === undefined) delete process.env[GENERAL_MAX_VAR];
    else process.env[GENERAL_MAX_VAR] = savedGeneralMax;
    if (savedPollingMax === undefined) delete process.env[POLLING_MAX_VAR];
    else process.env[POLLING_MAX_VAR] = savedPollingMax;
  });

  describe('positiveIntOrDefault', () => {
    it.each([
      ['10', 5, 10],
      ['007', 5, 7],
      ['0', 5, 5],
      ['-1', 5, 5],
      ['abc', 5, 5],
      ['NaN', 5, 5],
      ['', 5, 5],
      ['2.5', 5, 5],
      [undefined, 5, 5],
    ])('positiveIntOrDefault(%p, 5) → %p', (value, fallback, expected) => {
      expect(positiveIntOrDefault(value, fallback)).toBe(expected);
    });
  });

  describe('default configuration', () => {
    it('advertises max 10 when BATCH_RATE_LIMIT_MAX is absent', async () => {
      const app = loadApp();
      const res = await request(app)
        .post('/api/batches')
        .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
      expect(res.status).toBe(202);
      expect(res.headers['ratelimit-limit']).toBe('10');
    });
  });

  describe('custom configuration', () => {
    it('honors BATCH_RATE_LIMIT_MAX=3 (3 × 202, then 429)', async () => {
      const app = loadApp({ [MAX_VAR]: '3' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/batches').send(body);
        expect(res.status).toBe(202);
      }
      const limited = await request(app).post('/api/batches').send(body);
      expect(limited.status).toBe(429);
      expect(limited.body.message).toBe('Too many batch requests. Please try again later.');
    });
  });

  describe('invalid configuration falls back safely', () => {
    it.each(['0', '-1', 'abc', 'NaN', '', '2.5'])(
      'BATCH_RATE_LIMIT_MAX=%p behaves as the default max of 10',
      async (value) => {
        const app = loadApp({ [MAX_VAR]: value });
        const res = await request(app)
          .post('/api/batches')
          .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
        expect(res.status).toBe(202);
        expect(res.headers['ratelimit-limit']).toBe('10');
      },
    );
  });

  describe('window configuration', () => {
    it('a short configured window resets the budget without long waits', async () => {
      const app = loadApp({ [MAX_VAR]: '1', [WINDOW_VAR]: '500' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      expect((await request(app).post('/api/batches').send(body)).status).toBe(202);
      expect((await request(app).post('/api/batches').send(body)).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await request(app).post('/api/batches').send(body)).status).toBe(202);
    }, 10000);
  });

  describe('endpoint scope', () => {
    it('GET polling does not consume the strict batch-creation budget', async () => {
      const app = loadApp({ [MAX_VAR]: '2' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      const created = await request(app).post('/api/batches').send(body);
      expect(created.status).toBe(202);
      const batchId = created.body.data.batchId;

      // 10 polls + results fetch: all must succeed under the general limiter.
      for (let i = 0; i < 10; i++) {
        const res = await request(app).get(`/api/batches/${batchId}`);
        expect(res.status).toBe(200);
      }
      expect((await request(app).get(`/api/batches/${batchId}/results`)).status).toBe(200);

      // Only one creation used so far: one more POST succeeds, then 429.
      expect((await request(app).post('/api/batches').send(body)).status).toBe(202);
      expect((await request(app).post('/api/batches').send(body)).status).toBe(429);
    });

    it('GET polling bypasses a tiny general limit (dedicated polling budget)', async () => {
      // General budget of 5 would 429 the 6th request if polling counted
      // toward it; all 10 polls must succeed on the polling limiter instead.
      const app = loadApp({ [GENERAL_MAX_VAR]: '5', [POLLING_MAX_VAR]: '50' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      const created = await request(app).post('/api/batches').send(body);
      expect(created.status).toBe(202);
      const batchId = created.body.data.batchId;

      for (let i = 0; i < 10; i++) {
        const res = await request(app).get(`/api/batches/${batchId}`);
        expect(res.status).toBe(200);
      }
    });

    it('tight polling loops still hit the dedicated polling limiter', async () => {
      const app = loadApp({ [POLLING_MAX_VAR]: '2' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      const created = await request(app).post('/api/batches').send(body);
      expect(created.status).toBe(202);
      const batchId = created.body.data.batchId;

      expect((await request(app).get(`/api/batches/${batchId}`)).status).toBe(200);
      expect((await request(app).get(`/api/batches/${batchId}`)).status).toBe(200);
      const limited = await request(app).get(`/api/batches/${batchId}`);
      expect(limited.status).toBe(429);
      expect(limited.body.message).toBe('Too many status requests. Please slow down polling.');
    });
  });
});
