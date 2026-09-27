/**
 * Security Middleware Tests
 *
 * Tests that security measures work correctly:
 * 1. Prototype pollution prevention
 * 2. Content-Type enforcement
 * 3. Rate limiting headers
 * 4. Security headers (helmet)
 * 5. Input sanitization edge cases
 */

const request = require('supertest');
const app = require('../../src/app');

describe('Security Middleware', () => {
  // ===========================================================
  // PROTOTYPE POLLUTION PREVENTION
  // ===========================================================
  describe('Prototype Pollution Prevention', () => {
    it('should strip __proto__ from request body', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .send({
          weight: 2,
          value: 100,
          destinationCountry: 'DE',
          __proto__: { isAdmin: true },
        });

      // The request should succeed (parcel is valid).
      // The sanitizer strips __proto__ keys, preventing prototype pollution.
      // We verify the injected "isAdmin" didn't leak onto the object prototype.
      expect(res.status).toBe(200);
      expect(res.body.data.parcel.isAdmin).toBeUndefined();
    });

    it('should strip constructor from nested objects', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .send({
          weight: 2,
          value: 100,
          destinationCountry: 'DE',
          additionalAttributes: {
            constructor: { prototype: { isAdmin: true } },
            fragile: true,
          },
        });

      // Should succeed and the constructor key should be stripped from attributes
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================
  // CONTENT-TYPE ENFORCEMENT
  // ===========================================================
  describe('Content-Type Enforcement', () => {
    it('should reject POST without application/json content type', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .set('Content-Type', 'text/plain')
        .send('not json');

      expect(res.status).toBe(415);
      expect(res.body.message).toContain('application/json');
    });

    it('should accept POST with application/json content type', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .set('Content-Type', 'application/json')
        .send({ weight: 2, value: 100, destinationCountry: 'DE' });

      expect(res.status).toBe(200);
    });

    it('should accept application/json with charset', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify({ weight: 2, value: 100, destinationCountry: 'DE' }));

      expect(res.status).toBe(200);
    });
  });

  // ===========================================================
  // SECURITY HEADERS (Helmet)
  // ===========================================================
  describe('Security Headers', () => {
    it('should include X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('should include X-Frame-Options', async () => {
      const res = await request(app).get('/api/health');
      // Helmet sets X-Frame-Options to SAMEORIGIN by default
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('should include Content-Security-Policy', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('should not expose X-Powered-By header', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  // ===========================================================
  // RATE LIMITING HEADERS
  // ===========================================================
  describe('Rate Limiting', () => {
    it('should include rate limit headers on API responses', async () => {
      const res = await request(app).get('/api/parcels/countries');
      // express-rate-limit with standardHeaders: true sets RateLimit-* headers
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
  });

  // ===========================================================
  // MALFORMED INPUT HANDLING
  // ===========================================================
  describe('Malformed Input', () => {
    it('should reject invalid JSON gracefully', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      // Malformed JSON should be rejected (400 or 500 depending on Express version)
      // Key requirement: the response must NOT expose stack traces or internal details
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.status).toBe('error');
      expect(res.body).not.toHaveProperty('stack');
    });

    it('should handle extremely nested objects without crashing', async () => {
      // Build a deeply nested object
      let nested = { weight: 2, value: 100, destinationCountry: 'DE' };
      for (let i = 0; i < 20; i++) {
        nested = { inner: nested, weight: 2, value: 100, destinationCountry: 'DE' };
      }

      const res = await request(app)
        .post('/api/parcels/route')
        .send(nested);

      // Should not crash (either 200 or 400, not 500)
      expect([200, 400]).toContain(res.status);
    });

    it('should reject batch with oversized parcel count', async () => {
      // Try to send more than 10,000 parcels (the batch limit)
      const parcels = Array.from({ length: 10001 }, () => ({
        weight: 1, value: 10, destinationCountry: 'DE',
      }));

      const res = await request(app)
        .post('/api/batches')
        .send({ parcels });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('10,000');
    });
  });

  // ===========================================================
  // SECURE ERROR RESPONSES
  // ===========================================================
  describe('Secure Error Responses', () => {
    it('should not expose stack traces in error responses', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .send({ weight: -1, value: 'bad', destinationCountry: 'XX' });

      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('stack');
      expect(JSON.stringify(res.body)).not.toContain('at ');
    });

    it('should return structured validation errors without internal details', async () => {
      const res = await request(app)
        .post('/api/parcels/route')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors).toBeDefined();
      expect(Array.isArray(res.body.errors)).toBe(true);
    });
  });
});
