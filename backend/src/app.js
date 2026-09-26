/**
 * Express Application Setup
 *
 * Configures middleware and routes.
 * Separated from index.js so the app can be imported by tests
 * without starting the server.
 *
 * MIDDLEWARE ORDER (important):
 * 1. Helmet (security headers) — must be first to set headers on all responses
 * 2. CORS — must be before routes for preflight to work
 * 3. Rate limiting — before body parsing to reject early
 * 4. Body parsing (express.json) — with size limit
 * 5. Input sanitization — after parsing, before routes
 * 6. Content-Type enforcement — before routes
 * 7. Routes
 * 8. Error handler — must be last
 */

const express = require('express');
const parcelRoutes = require('./api/routes/parcelRoutes');
const { errorHandler } = require('./api/middleware/errorHandler');
const {
  createCorsMiddleware,
  createGeneralRateLimiter,
  createBatchRateLimiter,
  createHelmetMiddleware,
  sanitizeInput,
  requireJsonContentType,
} = require('./api/middleware/security');

const app = express();

// --- 1. Security Headers (helmet) ---
// Threat: XSS, clickjacking, MIME sniffing
// Protection: HTTP security headers on every response
app.use(createHelmetMiddleware());

// --- 2. CORS ---
// Threat: Cross-origin abuse
// Protection: Restrict to known frontend origins in production
app.use(createCorsMiddleware());

// --- 3. Rate Limiting ---
// Threat: DDoS, brute-force, resource exhaustion
// Protection: Per-IP request limits
app.use('/api/', createGeneralRateLimiter());
app.use('/api/parcels/batch', createBatchRateLimiter());

// --- 4. Body Parsing ---
// Threat: Request smuggling, resource exhaustion via large payloads
// Protection: 10MB JSON limit (enough for ~10,000 parcels, prevents abuse)
app.use(express.json({ limit: '10mb' }));

// --- 5. Input Sanitization ---
// Threat: Prototype pollution via __proto__, constructor, prototype
// Protection: Strip dangerous keys from all request bodies
app.use(sanitizeInput);

// --- 6. Content-Type Enforcement ---
// Threat: CSRF via form submissions, content-type confusion
// Protection: Reject POST requests without application/json
app.use('/api/parcels', requireJsonContentType);

// --- Routes ---
app.use('/api/parcels', parcelRoutes);

// --- Health check (no rate limiting, no auth) ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Error handling (must be last) ---
app.use(errorHandler);

module.exports = app;
