/**
 * Production CORS must allow browser batch creation with Idempotency-Key:
 * preflight (OPTIONS) has to succeed, otherwise the real POST never fires.
 * Origins stay restrictive (explicit allowlist, never *).
 */

const request = require('supertest');

let savedNodeEnv;
let savedOrigins;

function loadApp(env = {}) {
  jest.resetModules();
  Object.assign(process.env, env);
  return require('../../src/app');
}

describe('Production CORS', () => {
  beforeAll(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedOrigins = process.env.CORS_ORIGINS;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = savedOrigins;
  });

  it('preflight allows Content-Type + Idempotency-Key from an allowed origin', async () => {
    const app = loadApp({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
    const res = await request(app)
      .options('/api/batches')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Idempotency-Key');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const allowed = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowed).toContain('content-type');
    expect(allowed).toContain('idempotency-key');
  });

  it('preflight allows X-Request-ID tracing header', async () => {
    const app = loadApp({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
    const res = await request(app)
      .options('/api/batches')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Request-ID');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect((res.headers['access-control-allow-headers'] || '').toLowerCase()).toContain('x-request-id');
  });

  it('does not echo disallowed origins (no wildcard)', async () => {
    const app = loadApp({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
    const res = await request(app)
      .options('/api/batches')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Idempotency-Key');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    expect(res.headers['access-control-allow-origin'] || '').not.toContain('*');
  });
});
