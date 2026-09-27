/**
 * Authentication Middleware (Master Phase 11 — Security).
 *
 * Model: optional Bearer-token auth suitable for an assessment.
 * - If no tokens are configured (API_TOKENS / AUTH_TOKEN unset), the API stays
 *   open and every request is attributed to `anonymous`. This preserves backward
 *   compatibility for local development and existing tests.
 * - If tokens ARE configured, every protected request must present
 *   `Authorization: Bearer <token>`. Invalid/missing credentials → 401.
 *   The token identity becomes `req.user.id` and owns created batches.
 *
 * Why Bearer tokens and not sessions/JWT?
 * - Stateless, zero dependencies, explainable in an interview.
 * - JWT/session infrastructure would be over-engineering for this scope.
 * - Can evolve to JWT/OAuth without changing call sites (req.user.id contract).
 *
 * Secrets: tokens come ONLY from environment variables, never from code,
 * query strings, or logs.
 */

const { AppError } = require('../../errors/AppError');

/**
 * Returns the configured API tokens.
 * Supports API_TOKENS="a,b,c" and legacy AUTH_TOKEN="single".
 *
 * @returns {string[]}
 */
function getConfiguredTokens() {
  const raw = process.env.API_TOKENS || process.env.AUTH_TOKEN || '';
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Returns true when authentication is enforced.
 */
function isAuthEnabled() {
  return getConfiguredTokens().length > 0;
}

/**
 * Optional auth: attaches req.user, enforces Bearer token only when configured.
 */
function authOptional(req, _res, next) {
  const tokens = getConfiguredTokens();
  if (tokens.length === 0) {
    req.user = { id: 'anonymous', authenticated: false };
    return next();
  }

  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';

  if (!token || !tokens.includes(token)) {
    return next(new AppError('Unauthorized. Provide a valid Bearer token.', 401));
  }

  // Do not expose the raw token downstream; use a stable short identity.
  req.user = { id: `token-${token.slice(0, 6)}`, authenticated: true };
  return next();
}

module.exports = {
  getConfiguredTokens,
  isAuthEnabled,
  authOptional,
};
