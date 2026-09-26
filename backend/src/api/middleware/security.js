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
    // Development: allow any origin (Vite runs on varying ports)
    return cors();
  }

  // Production: restrict to configured origins
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400, // Cache preflight for 24 hours
  });
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
 * - General API: 100 requests per 15 minutes
 * - Batch endpoint: 10 requests per 15 minutes (each batch is expensive)
 */
function createGeneralRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,                  // 100 requests per window
    standardHeaders: true,     // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,      // Disable `X-RateLimit-*` headers
    message: {
      status: 'error',
      message: 'Too many requests. Please try again later.',
    },
  });
}

function createBatchRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // 10 batch requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: 'error',
      message: 'Too many batch requests. Please try again later.',
    },
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
  createHelmetMiddleware,
  sanitizeInput,
  requireJsonContentType,
};
