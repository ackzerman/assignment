/**
 * Redis Client — shared connection for temporary batch state.
 *
 * Redis is the authoritative TEMPORARY state system:
 * - BullMQ queue jobs (via BullMQ's own connection in queue.js)
 * - batch processing state, progress, chunk checkpoints, results (via batchStore.js)
 *
 * Nothing here is permanent: all batch keys carry a TTL and expire after the
 * processing session ends. There is no relational database in this architecture.
 *
 * Connection:
 * - Production: REDIS_URL (preferred, supports password/TLS params) or
 *   REDIS_HOST / REDIS_PORT / REDIS_PASSWORD.
 * - The client connects lazily on first use so importing this module never
 *   performs I/O (important for tests, which inject ioredis-mock instead).
 * - Redis is intentionally NOT publicly exposed: default bind is localhost
 *   and credentials travel via environment only, never code or logs.
 */

const { logger } = require('../observability/logger');

let RedisImpl = null;
let client = null;
let connectionPromise = null;

function getRedisImpl() {
  if (!RedisImpl) {
    RedisImpl = require('ioredis');
  }
  return RedisImpl;
}

/**
 * Overrides the Redis implementation (tests inject ioredis-mock).
 * Resets any existing client so the next use picks up the override.
 */
function setRedisImplementation(impl) {
  RedisImpl = impl;
  client = null;
  connectionPromise = null;
}

function buildOptions() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  const options = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    lazyConnect: true,
    // Fail fast on state operations instead of buffering forever when down.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  };
  if (process.env.REDIS_PASSWORD) {
    options.password = process.env.REDIS_PASSWORD;
  }
  return options;
}

/**
 * Returns the shared Redis client, connecting on first use.
 */
async function getRedisClient() {
  if (client) {
    if (client.status === 'ready' || client.status === 'connect') {
      return client;
    }
    // Previous client died; drop it and reconnect below.
    try { client.disconnect(); } catch { /* ignore */ }
    client = null;
    connectionPromise = null;
  }
  if (!connectionPromise) {
    const Redis = getRedisImpl();
    const instance = new Redis(buildOptions());
    instance.on('error', (err) => {
      logger.warn('Redis client error', { error: err.message });
    });
    client = instance;
    connectionPromise = instance.connect().then(() => instance).catch((err) => {
      // Reset so the next call retries instead of reusing a dead client.
      if (client === instance) {
        try { instance.disconnect(); } catch { /* ignore */ }
        client = null;
      }
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Lightweight availability probe used by batch creation and readiness.
 * Resolves true when Redis answers, false otherwise (never throws).
 */
async function pingRedis() {
  try {
    const redis = await getRedisClient();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Closes the shared client. Used for graceful shutdown and test teardown.
 */
async function closeRedis() {
  connectionPromise = null;
  if (client) {
    const instance = client;
    client = null;
    try {
      await instance.quit();
    } catch {
      try { instance.disconnect(); } catch { /* ignore */ }
    }
    logger.info('Redis connection closed');
  }
  await stopEmbeddedRedis();
}

let embeddedServer = null;

/**
 * Starts a local embedded Redis (real redis-server binary, loopback only)
 * when EMBEDDED_REDIS=1 — for development/demo machines without Redis.
 * Points REDIS_HOST/PORT at it so the state client AND BullMQ (which reads
 * env config) both use it. No-op unless explicitly enabled. Opt-in only:
 * production must provide real Redis via REDIS_URL / REDIS_HOST.
 *
 * @returns {{ host: string, port: number } | null}
 */
async function startEmbeddedRedisIfEnabled() {
  if (process.env.EMBEDDED_REDIS !== '1' || embeddedServer) {
    return embeddedServer ? { host: process.env.REDIS_HOST, port: parseInt(process.env.REDIS_PORT, 10) } : null;
  }
  let RedisMemoryServer;
  try {
    ({ RedisMemoryServer } = require('redis-memory-server'));
  } catch {
    throw new Error('EMBEDDED_REDIS=1 requires the redis-memory-server devDependency (run npm install).');
  }
  embeddedServer = new RedisMemoryServer({ instance: {} });
  const host = await embeddedServer.getHost();
  const port = await embeddedServer.getPort();
  process.env.REDIS_HOST = host;
  process.env.REDIS_PORT = String(port);
  logger.info('Embedded Redis started (local demo only)', { host, port });
  return { host, port };
}

async function stopEmbeddedRedis() {
  if (embeddedServer) {
    const instance = embeddedServer;
    embeddedServer = null;
    try {
      await instance.stop();
    } catch { /* ignore */ }
    logger.info('Embedded Redis stopped');
  }
}

module.exports = {
  getRedisClient,
  closeRedis,
  pingRedis,
  setRedisImplementation,
  startEmbeddedRedisIfEnabled,
  stopEmbeddedRedis,
};
