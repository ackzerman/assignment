/**
 * Server Entry Point
 *
 * Starts the Express server, initializes infrastructure (Redis + queue + worker),
 * and handles graceful shutdown. There is no relational database: Redis holds
 * all temporary batch state (TTL-expired after the processing session).
 *
 * Separated from app.js so tests can import the app without starting
 * the full server or infrastructure.
 *
 * Graceful shutdown sequence:
 * 1. Stop accepting new HTTP connections
 * 2. Stop the worker (finish current job)
 * 3. Close the queue connection
 * 4. Close the Redis connection
 * 5. Exit
 */

require('dotenv').config();
const app = require('./app');
const { pingRedis, closeRedis, startEmbeddedRedisIfEnabled } = require('./infrastructure/redis');
const { initQueue, closeQueue } = require('./infrastructure/queue');
const { createWorker, closeWorker } = require('./infrastructure/worker');
const { logger } = require('./observability/logger');

const PORT = process.env.PORT || 3001;

// --- Infrastructure initialization ---
let server;

async function start() {
  try {
    // 0. Opt-in local demo Redis (EMBEDDED_REDIS=1) for machines without Redis.
    // Points REDIS_HOST/PORT at the embedded instance before anything connects.
    const embedded = await startEmbeddedRedisIfEnabled();
    const bullMqConnection = embedded
      ? { host: embedded.host, port: embedded.port, maxRetriesPerRequest: null }
      : undefined;

    // 1. Verify Redis (temporary batch state + queue backend).
    // Start serving anyway when Redis is down so /health/ready can report
    // not_ready; batch creation fails fast with 503 until Redis recovers.
    if (await pingRedis()) {
      logger.info('Redis ready');
    } else {
      logger.warn('Redis unavailable at startup; batch creation will return 503 until it recovers');
    }

    // 2. Initialize queue (connects to Redis)
    initQueue(bullMqConnection);
    logger.info('Queue ready');

    // 3. Start worker (consumes batch jobs from queue)
    createWorker(bullMqConnection ? { connection: bullMqConnection } : undefined);
    logger.info('Worker ready');

    // 4. Start HTTP server
    server = app.listen(PORT, () => {
      logger.info('Server started', { port: PORT });
      console.log(`[Server] Parcel Routing System running on port ${PORT}`);
      console.log(`[Server] Health check: http://localhost:${PORT}/health/live`);
      console.log(`[Server] API docs: POST /api/parcels/route, POST /api/batches`);
    });

    // Set server timeout to prevent hanging requests
    server.timeout = 30000; // 30 seconds

  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
}

// --- Graceful Shutdown ---

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutdown initiated', { signal });
  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);

  try {
    // 1. Stop accepting new HTTP connections
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      logger.info('HTTP server closed');
    }

    // 2. Stop worker (finish current job)
    await closeWorker();
    logger.info('Worker closed');

    // 3. Close queue connection
    await closeQueue();
    logger.info('Queue closed');

    // 4. Close Redis connection
    await closeRedis();
    logger.info('Redis closed');

    logger.info('Shutdown complete');
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    console.error('[Server] Shutdown error:', err.message);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

// Catch uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  // Exit on uncaught exceptions — the process is in an unknown state
  process.exit(1);
});

start();
