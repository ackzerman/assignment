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
const batchRoutes = require('./api/routes/batchRoutes');
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
const { getMetrics, setQueueDepth } = require('./observability/metrics');
const { checkForAnomalies } = require('./observability/anomalyDetector');
const { getQueueHealth } = require('./infrastructure/queue');

const app = express();

// --- 1. Request ID ---
// Assigns a unique ID for log correlation across the request lifecycle
app.use(requestId);

// --- 2. Security Headers (helmet) ---
app.use(createHelmetMiddleware());

// --- 3. CORS ---
app.use(createCorsMiddleware());

// --- 4. Rate Limiting ---
// The strict batch-creation limiter applies ONLY to POST /api/batches
// (each creation enqueues expensive worker capacity). GET status/results
// polling bypasses the general limiter (see isBatchPollRequest) and uses a
// dedicated polling limiter mounted on the batch GET routes — otherwise a
// normal batch taking longer than ~10 polls would 429 legitimate polling.
app.use('/api/', createGeneralRateLimiter());
app.post('/api/batches', createBatchRateLimiter());

// --- 5. Body Parsing ---
app.use(express.json({ limit: '10mb' }));

// --- 6. Input Sanitization ---
app.use(sanitizeInput);

// --- 7. Content-Type Enforcement ---
// Apply to both single parcel and batch POST endpoints
app.use('/api/parcels', requireJsonContentType);
app.use('/api/batches', requireJsonContentType);

// --- 8. Request Logging ---
app.use(requestLogger);

// --- Routes ---
// Single parcel routing (synchronous)
app.use('/api/parcels', parcelRoutes);

// Batch processing (asynchronous via queue)
app.use('/api/batches', batchRoutes);

// --- Health Endpoints (Phase 10: Reliability) ---

/**
 * GET /health/live — Liveness check
 * Answers: "Is the process alive?"
 * If this returns 200, the process is running.
 * No dependency checks — if the process can respond, it's alive.
 */
app.get('/health/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready — Readiness check
 * Answers: "Can this instance safely receive work?"
 * Checks critical dependencies: Redis state and queue connectivity.
 */
app.get('/health/ready', async (_req, res) => {
  const checks = {};

  // Check Redis (authoritative temporary batch state)
  try {
    const { pingRedis } = require('./infrastructure/redis');
    const ok = await pingRedis();
    checks.redis = ok ? { status: 'ok' } : { status: 'error', message: 'Redis unavailable' };
  } catch (err) {
    checks.redis = { status: 'error', message: err.message };
  }

  // Check queue
  try {
    const queueHealth = await getQueueHealth();
    checks.queue = queueHealth.connected
      ? { status: 'ok', depth: queueHealth.depth }
      : { status: 'error', message: queueHealth.error };
    if (queueHealth.connected) {
      setQueueDepth(queueHealth.depth || 0);
    }
  } catch (err) {
    checks.queue = { status: 'error', message: err.message };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'ok');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// --- Legacy health check (kept for backwards compatibility) ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Metrics endpoint ---
// Returns operational metrics and department distribution.
// Refreshes queue depth when the queue is reachable (Master: backpressure visibility).
app.get('/api/metrics', async (_req, res) => {
  try {
    const queueHealth = await getQueueHealth();
    if (queueHealth.connected) {
      setQueueDepth(queueHealth.depth || 0);
    }
  } catch {
    // Metrics must never fail because monitoring is unavailable.
  }
  res.json({
    status: 'success',
    data: getMetrics(),
  });
});

// --- Anomaly check endpoint ---
// Returns current health status and any active alerts
app.get('/api/health/detailed', (_req, res) => {
  const anomalyCheck = checkForAnomalies();
  res.status(200).json({
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
