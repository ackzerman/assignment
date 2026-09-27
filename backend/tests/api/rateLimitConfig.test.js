/**
 * Rate-limit configuration tests.
 *
 * Budgets (each with an INDEPENDENT window):
 * - General API: 300 requests / 15 minutes
 * - Batch creation: 30 requests / 10 minutes (POST /api/batches only)
 * - Batch polling: 1200 requests / 15 minutes (GET status/results)
 *
 * - Invalid values (0/negative/NaN/decimal/malformed) fall back safely.
 * - GET polling never consumes the general interactive budget.
 * - Each fresh app load gets fresh limiter state (no long waits, except one
 *   short-window reset test).
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
const {
  positiveIntOrDefault,
  getRateLimitConfig,
  RATE_LIMIT_DEFAULTS,
} = require('../../src/api/middleware/security');

const GENERAL_WINDOW_VAR = 'RATE_LIMIT_WINDOW_MS';
const GENERAL_MAX_VAR = 'RATE_LIMIT_MAX';
const BATCH_WINDOW_VAR = 'BATCH_RATE_LIMIT_WINDOW_MS';
const BATCH_MAX_VAR = 'BATCH_RATE_LIMIT_MAX';
const POLLING_WINDOW_VAR = 'POLLING_RATE_LIMIT_WINDOW_MS';
const POLLING_MAX_VAR = 'POLLING_RATE_LIMIT_MAX';
const ALL_VARS = [
  GENERAL_WINDOW_VAR, GENERAL_MAX_VAR,
  BATCH_WINDOW_VAR, BATCH_MAX_VAR,
  POLLING_WINDOW_VAR, POLLING_MAX_VAR,
];

const saved = {};

function loadApp(env = {}) {
  jest.resetModules();
  for (const v of ALL_VARS) delete process.env[v];
  Object.assign(process.env, env);
  const freshRedis = require('../../src/infrastructure/redis');
  freshRedis.setRedisImplementation(RedisMock);
  const freshQueue = require('../../src/infrastructure/queue');
  freshQueue.addBatchJob.mockImplementation(async (batchId) => ({ id: `mock-${batchId}`, batchId }));
  freshQueue.getQueueHealth.mockResolvedValue({ connected: false, error: 'mock' });
  return require('../../src/app');
}

describe('Rate-limit configuration', () => {
  beforeAll(() => {
    for (const v of ALL_VARS) saved[v] = process.env[v];
  });

  afterEach(() => {
    for (const v of ALL_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
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

  describe('required defaults (300/15m, 30/10m, 1200/15m)', () => {
    it('matches the mandated budgets and windows', () => {
      expect(RATE_LIMIT_DEFAULTS.general).toEqual({ windowMs: 15 * 60 * 1000, max: 300 });
      expect(RATE_LIMIT_DEFAULTS.batch).toEqual({ windowMs: 10 * 60 * 1000, max: 30 });
      expect(RATE_LIMIT_DEFAULTS.polling).toEqual({ windowMs: 15 * 60 * 1000, max: 1200 });
    });

    it('resolves the mandated budgets from an empty environment', () => {
      for (const v of ALL_VARS) delete process.env[v];
      expect(getRateLimitConfig()).toEqual({
        general: { windowMs: 900000, max: 300 },
        batch: { windowMs: 600000, max: 30 },
        polling: { windowMs: 900000, max: 1200 },
      });
    });

    it('batch window is 10 minutes (not 15)', () => {
      for (const v of ALL_VARS) delete process.env[v];
      expect(getRateLimitConfig().batch.windowMs).toBe(10 * 60 * 1000);
    });

    it('windows are independently configurable', () => {
      for (const v of ALL_VARS) delete process.env[v];
      process.env[BATCH_WINDOW_VAR] = '12345';
      const cfg = getRateLimitConfig();
      expect(cfg.batch.windowMs).toBe(12345);
      expect(cfg.general.windowMs).toBe(900000);
      expect(cfg.polling.windowMs).toBe(900000);
    });

    it.each(['0', '-1', 'abc', 'NaN', '', '2.5'])(
      'invalid general max %p falls back to 300',
      (value) => {
        for (const v of ALL_VARS) delete process.env[v];
        process.env[GENERAL_MAX_VAR] = value;
        expect(getRateLimitConfig().general.max).toBe(300);
      },
    );

    it.each(['0', '-5', 'nope', 'NaN', '1.5'])(
      'invalid batch/polling values fall back safely',
      (value) => {
        for (const v of ALL_VARS) delete process.env[v];
        process.env[BATCH_MAX_VAR] = value;
        process.env[POLLING_MAX_VAR] = value;
        process.env[BATCH_WINDOW_VAR] = value;
        process.env[POLLING_WINDOW_VAR] = value;
        const cfg = getRateLimitConfig();
        expect(cfg.batch.max).toBe(30);
        expect(cfg.polling.max).toBe(1200);
        expect(cfg.batch.windowMs).toBe(600000);
        expect(cfg.polling.windowMs).toBe(900000);
      },
    );
  });

  describe('advertised defaults', () => {
    it('general limiter advertises 300', async () => {
      const app = loadApp();
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('300');
    });

    it('batch limiter advertises 30', async () => {
      const app = loadApp();
      const res = await request(app)
        .post('/api/batches')
        .send({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] });
      expect(res.status).toBe(202);
      expect(res.headers['ratelimit-limit']).toBe('30');
    });
  });

  describe('general budget: first 300 accepted, 301st rejected', () => {
    it('300 × 200 then 429', async () => {
      const app = loadApp();
      for (let i = 0; i < 300; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
      const limited = await request(app).get('/api/health');
      expect(limited.status).toBe(429);
    }, 120000);
  });

  describe('batch budget: first 30 accepted, 31st rejected', () => {
    it('30 × 202 then 429', async () => {
      const app = loadApp();
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      for (let i = 0; i < 30; i++) {
        const res = await request(app).post('/api/batches').send(body);
        expect(res.status).toBe(202);
      }
      const limited = await request(app).post('/api/batches').send(body);
      expect(limited.status).toBe(429);
      expect(limited.body.message).toBe('Too many batch requests. Please try again later.');
    }, 120000);
  });

  describe('window configuration', () => {
    it('a short batch window resets the budget without long waits', async () => {
      const app = loadApp({ [BATCH_MAX_VAR]: '1', [BATCH_WINDOW_VAR]: '500' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      expect((await request(app).post('/api/batches').send(body)).status).toBe(202);
      expect((await request(app).post('/api/batches').send(body)).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await request(app).post('/api/batches').send(body)).status).toBe(202);
    }, 10000);
  });

  describe('endpoint scope', () => {
    it('GET polling does not consume the strict batch-creation budget', async () => {
      const app = loadApp({ [BATCH_MAX_VAR]: '31' });
      const body = { parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] };
      const created = await request(app).post('/api/batches').send(body);
      expect(created.status).toBe(202);
      const batchId = created.body.data.batchId;

      for (let i = 0; i < 10; i++) {
        const res = await request(app).get(`/api/batches/${batchId}`);
        expect(res.status).toBe(200);
      }
      expect((await request(app).get(`/api/batches/${batchId}/results`)).status).toBe(200);

      // Polling consumed nothing from the creation budget: 30 more POSTs fit.
      for (let i = 0; i < 30; i++) {
        const res = await request(app).post('/api/batches').send(body);
        expect(res.status).toBe(202);
      }
      expect((await request(app).post('/api/batches').send(body)).status).toBe(429);
    }, 60000);

    it('GET polling bypasses a tiny general limit (dedicated polling budget)', async () => {
      const app = loadApp({ [GENERAL_MAX_VAR]: '5', [POLLING_MAX_VAR]: '1200' });
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
