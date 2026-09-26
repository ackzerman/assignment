/**
 * Express Application Setup
 *
 * Configures middleware and routes.
 * Separated from index.js so the app can be imported by tests
 * without starting the server.
 *
 * MIDDLEWARE ORDER (important):
 * 1. Request ID — assign unique ID for log correlation (must be first)
 * 2. Helmet (security headers) — set headers on all responses
 * 3. CORS — must be before routes for preflight to work
 * 4. Rate limiting — before body parsing to reject early
 * 5. Body parsing (express.json) — with size limit
 * 6. Input sanitization — after parsing, before routes
 * 7. Content-Type enforcement — before routes
 * 8. Request logging — log after body is parsed
 * 9. Routes
 * 10. Error handler — must be last
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
const { requestId, requestLogger } = require('./api/middleware/requestLogger');
const { getMetrics } = require('./observability/metrics');
const { checkForAnomalies } = require('./observability/anomalyDetector');

const app = express();

// --- 1. Request ID ---
// Assigns a unique ID for log correlation across the request lifecycle
app.use(requestId);

// --- 2. Security Headers (helmet) ---
app.use(createHelmetMiddleware());

// --- 3. CORS ---
app.use(createCorsMiddleware());

// --- 4. Rate Limiting ---
app.use('/api/', createGeneralRateLimiter());
app.use('/api/parcels/batch', createBatchRateLimiter());

// --- 5. Body Parsing ---
app.use(express.json({ limit: '10mb' }));

// --- 6. Input Sanitization ---
app.use(sanitizeInput);

// --- 7. Content-Type Enforcement ---
app.use('/api/parcels', requireJsonContentType);

// --- 8. Request Logging ---
app.use(requestLogger);

// --- Routes ---
app.use('/api/parcels', parcelRoutes);

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Metrics endpoint ---
// Returns operational metrics and department distribution
app.get('/api/metrics', (_req, res) => {
  res.json({
    status: 'success',
    data: getMetrics(),
  });
});

// --- Anomaly check endpoint ---
// Returns current health status and any active alerts
app.get('/api/health/detailed', (_req, res) => {
  const anomalyCheck = checkForAnomalies();
  const statusCode = anomalyCheck.healthy ? 200 : 200; // Always 200; alerts are informational
  res.status(statusCode).json({
    status: 'success',
    data: {
      ...anomalyCheck,
      metrics: getMetrics(),
    },
  });
});

// --- Error handling (must be last) ---
app.use(errorHandler);

module.exports = app;
