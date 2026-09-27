/**
 * Request ID hardening: client-provided X-Request-ID values are untrusted.
 * Only safe values are reused for tracing; anything else gets a
 * server-generated UUID so overlong/malformed input can never propagate
 * into response headers or structured logs.
 */

const request = require('supertest');

let app;

describe('Request ID hardening', () => {
  beforeAll(() => {
    app = require('../../src/app');
  });

  it('reuses a valid client-provided request ID', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Request-ID', 'trace-abc-123_ABC.:-');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123_ABC.:-');
  });

  it('generates a server-side UUID when no request ID is sent', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects an overlong request ID with a generated UUID', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Request-ID', 'x'.repeat(5000));
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).not.toHaveLength(5000);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['with spaces'],
    ['<script>alert(1)</script>'],
    ['semi;colon'],
    ['quote"test'],
  ])('rejects malformed request ID %p with a generated UUID', async (bad) => {
    const res = await request(app).get('/api/health').set('X-Request-ID', bad);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).not.toBe(bad);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
