/**
 * Oversized request bodies must return 413 Payload Too Large (never 500),
 * with a safe public message and no internals leaked.
 */

const request = require('supertest');
const { errorHandler } = require('../../src/api/middleware/errorHandler');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('Entity-too-large handling', () => {
  it('maps body-parser entity.too.large to 413 with a safe message', () => {
    const err = new Error('request entity too large');
    err.type = 'entity.too.large';
    err.status = 413;
    err.statusCode = 413;
    const res = mockRes();
    errorHandler(err, { id: 'test-id' }, res, () => {});
    expect(res.statusCode).toBe(413);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toMatch(/too large/i);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|entity\.too\.large/);
  });

  it('maps bare statusCode 413 to 413', () => {
    const err = new Error('too big');
    err.statusCode = 413;
    const res = mockRes();
    errorHandler(err, { id: 'test-id' }, res, () => {});
    expect(res.statusCode).toBe(413);
  });

  it('app-level: an 11 MB JSON body to /api/parcels returns 413, not 500', async () => {
    const app = require('../../src/app');
    const big = `{"weight": 1, "value": 1, "destinationCountry": "DE", "pad": "${'x'.repeat(11 * 1024 * 1024)}"}`;
    const res = await request(app)
      .post('/api/parcels')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body.status).toBe('error');
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\(|node_modules/);
  }, 30000);
});
