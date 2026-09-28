/**
 * Security Middleware
 *
 * Centralizes all security-related middleware for the application.
 * Each measure maps to a specific threat and has a documented reason.
 *
 * Threat Model (for a public-facing parcel routing API):
 *
 * 1. XSS / Header Injection → helmet (security headers)
 * 2. DDoS / Brute Force     → rate limiting
 * 3. Request Smuggling       → JSON body size limit
 * 4. CORS Abuse              → restrictive CORS origin
 * 5. Prototype Pollution     → input sanitization
 * 6. Resource Exhaustion     → batch size limits, body limits
 *
 * IMPORTANT: For every security measure below, the comment explains:
 *   Threat → Protection → Why it matters
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { positiveIntOrDefault } = require('../../config');

/**
 * Creates the CORS middleware with environment-aware configuration.
 *
 * Threat: Cross-Origin abuse — unauthorized domains making API calls.
 * Protection: Restrict origins to known frontend URLs.
 * Why it matters: Prevents malicious sites from making requests
 *   to our API using a victim's browser/session.
 *
 * In development: allow localhost origins for Vite dev server.
 * In production: restrict to the deployed frontend URL.
 */
function createCorsMiddleware() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    // Development: allow any origin (Vite runs on varying ports), but expose
    // the same headers as production so browser clients behave identically
    // in dev and prod (Retry-After on 429, X-Request-ID tracing).
    return cors({ exposedHeaders: ['X-Request-ID', 'Retry-After'] });
  }

  // Production: restrict to configured origins
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ['GET', 'POST'],
    // Batch creation sends Idempotency-Key; distributed tracing may send
    // X-Request-ID. Both must be preflight-allowed or browser clients fail
    // OPTIONS before the real request ever fires. Origins stay restrictive
    // (explicit allowlist, never *).
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Retry-After'],
    maxAge: 86400, // Cache preflight for 24 hours
  });
}

/**
 * Rate-limit configuration (single source of truth for defaults).
 *
 * - General API: 300 requests / 15 minutes
 * - Batch creation: 30 requests / 10 minutes
 * - Batch polling: 1200 requests / 15 minutes
 *
 * Each limiter has INDEPENDENT window/max variables so tuning one never
 * silently retunes another. Invalid values fall back to the safe defaults
 * below (never 0/unlimited/NaN — see positiveIntOrDefault).
 */
const RATE_LIMIT_DEFAULTS = {
  general: { windowMs: 15 * 60 * 1000, max: 300 },
  batch: { windowMs: 10 * 60 * 1000, max: 30 },
  polling: { windowMs: 15 * 60 * 1000, max: 1200 },
};

/**
 * Resolves the effective rate-limit configuration from the environment.
 * Exported so tests and operators can verify actual behavior (no hidden
 * hard-coded values).
 */
function getRateLimitConfig() {
  return {
    general: {
      windowMs: positiveIntOrDefault(process.env.RATE_LIMIT_WINDOW_MS, RATE_LIMIT_DEFAULTS.general.windowMs),
      max: positiveIntOrDefault(process.env.RATE_LIMIT_MAX, RATE_LIMIT_DEFAULTS.general.max),
    },
    batch: {
      windowMs: positiveIntOrDefault(process.env.BATCH_RATE_LIMIT_WINDOW_MS, RATE_LIMIT_DEFAULTS.batch.windowMs),
      max: positiveIntOrDefault(process.env.BATCH_RATE_LIMIT_MAX, RATE_LIMIT_DEFAULTS.batch.max),
    },
    polling: {
      windowMs: positiveIntOrDefault(process.env.POLLING_RATE_LIMIT_WINDOW_MS, RATE_LIMIT_DEFAULTS.polling.windowMs),
      max: positiveIntOrDefault(process.env.POLLING_RATE_LIMIT_MAX, RATE_LIMIT_DEFAULTS.polling.max),
    },
  };
}

/**
 * 429 handler shared by all limiters. Sets Retry-After explicitly (derived
 * from the limiter window) instead of relying on the express-rate-limit
 * version's default headers, so the contract holds across upgrades.
 * The JSON body matches what clients already handle.
 */
function limitedHandler(message, windowMs) {
  return (_req, res) => {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
    res.status(429).json({ status: 'error', message });
  };
}

/**
 * Creates rate limiting middleware.
 *
 * Threat: DDoS / brute-force / resource exhaustion.
 * Protection: Limit requests per IP per time window.
 * Why it matters: Prevents a single client from overwhelming
 *   the server or consuming all batch processing capacity.
 *
 * We use different limits for different endpoints:
 * - General API: 300 requests / 15 minutes
 * - Batch creation: 30 requests / 10 minutes (each batch is expensive).
 *   The batch limiter applies ONLY to POST /api/batches — status/results
 *   polling has its own dedicated limiter (createPollingRateLimiter) so
 *   legitimate polling is never throttled by creation limits.
 */
function createGeneralRateLimiter() {
  const cfg = getRateLimitConfig().general;
  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,     // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,      // Disable `X-RateLimit-*` headers
    // Batch status/results polling has its own dedicated limiter (see
    // createPollingRateLimiter); skip those paths here so a long-running
    // batch polling ~1/sec is never throttled by the interactive budget.
    skip: isBatchPollRequest,
    handler: limitedHandler('Too many requests. Please try again later.', cfg.windowMs),
  });
}

/**
 * Matches batch polling reads: GET /api/batches/:batchId and
 * GET /api/batches/:batchId/results. Uses req.originalUrl (never stripped
 * by mounts) so the match is stable regardless of router mounting.
 */
function isBatchPollRequest(req) {
  if (!req || req.method !== 'GET') return false;
  const url = (req.originalUrl || req.url || '').split('?')[0];
  return /^\/api\/batches\/[^/]+\/results\/?$/.test(url)
    || /^\/api\/batches\/[^/]+\/?$/.test(url);
}

/**
 * Dedicated limiter for batch status/results polling: 1200 / 15 minutes.
 *
 * Threat: polling abuse (a client hammering status in a tight loop).
 * Protection: generous dedicated budget, separate from interactive traffic.
 * Why it matters: legitimate polling (~1/sec for minutes) must survive,
 * while a tight abuse loop still gets throttled.
 */
function createPollingRateLimiter() {
  const cfg = getRateLimitConfig().polling;
  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: limitedHandler('Too many status requests. Please slow down polling.', cfg.windowMs),
  });
}

function createBatchRateLimiter() {
  const cfg = getRateLimitConfig().batch;
  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: limitedHandler('Too many batch requests. Please try again later.', cfg.windowMs),
  });
}

/**
 * Sanitizes request body to prevent prototype pollution attacks.
 *
 * Threat: Prototype pollution via __proto__, constructor, prototype keys.
 * Protection: Strip dangerous keys from request bodies recursively.
 * Why it matters: An attacker could inject { "__proto__": { "isAdmin": true } }
 *   to pollute Object.prototype and bypass authorization checks.
 *
 * This is a lightweight alternative to libraries like hpp or
 * express-mongo-sanitize — we don't need MongoDB-specific protection.
 */
function sanitizeInput(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = stripDangerousKeys(req.body);
  }
  next();
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripDangerousKeys(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item =>
      typeof item === 'object' && item !== null ? stripDangerousKeys(item) : item
    );
  }

  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue; // Silently strip dangerous keys
    }
    cleaned[key] = typeof value === 'object' && value !== null
      ? stripDangerousKeys(value)
      : value;
  }
  return cleaned;
}

/**
 * Configures helmet for security headers.
 *
 * Threat: XSS, clickjacking, MIME sniffing, information disclosure.
 * Protection: Set appropriate HTTP security headers.
 * Why it matters: Defense-in-depth — even if application code has a bug,
 *   browser security policies prevent exploitation.
 *
 * Headers set by helmet:
 * - Content-Security-Policy: Prevents XSS by restricting resource loading
 * - X-Content-Type-Options: nosniff — prevents MIME type confusion
 * - X-Frame-Options: DENY — prevents clickjacking
 * - Strict-Transport-Security: Forces HTTPS in production
 * - X-XSS-Protection: Legacy XSS filter (for older browsers)
 * - Referrer-Policy: Controls information in Referer header
 */
function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for React
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Not needed for an API
  });
}

/**
 * Validates that JSON Content-Type is set on POST requests.
 *
 * Threat: Content-type confusion / request smuggling.
 * Protection: Reject POST requests without proper JSON content type.
 * Why it matters: Prevents attackers from sending form-encoded data
 *   that might be parsed differently, or sending requests that
 *   bypass CORS preflight checks.
 */
function requireJsonContentType(req, res, next) {
  if (req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.status(415).json({
        status: 'error',
        message: 'Content-Type must be application/json.',
      });
      return;
    }
  }
  next();
}

module.exports = {
  createCorsMiddleware,
  createGeneralRateLimiter,
  createBatchRateLimiter,
  createPollingRateLimiter,
  getRateLimitConfig,
  RATE_LIMIT_DEFAULTS,
  isBatchPollRequest,
  createHelmetMiddleware,
  sanitizeInput,
  requireJsonContentType,
  positiveIntOrDefault,
};
