/**
 * Queue Infrastructure — BullMQ + Redis
 *
 * Provides durable job queueing for asynchronous batch processing.
 *
 * Design Decision: Why BullMQ?
 * - At-least-once delivery guarantees
 * - Built-in retry with configurable backoff
 * - Dead-letter queue support (failed jobs are preserved)
 * - Job progress tracking
 * - Graceful shutdown support
 * - Well-tested in production environments
 *
 * CRITICAL: The queue payload is SMALL — just { batchId }.
 * The worker loads the batch input from temporary Redis state.
 * This keeps queue messages lightweight and enables durable recovery.
 *
 * Redis mental model:
 * - Queue: "What work needs to happen?"
 * - Redis batch state: "What happened / what is the current state?"
 * Both expire: jobs are retained briefly, batch keys carry a TTL.
 */

const { Queue } = require('bullmq');
const { logger } = require('../observability/logger');
const { positiveIntOrDefault } = require('../config');

// Redis connection configuration.
// REDIS_URL is preferred (supports password/TLS params); otherwise host/port.
// Credentials come from environment only — Redis itself is never publicly exposed.
function getRedisConnection() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    // Validated: a malformed REDIS_PORT must fall back to 6379, never NaN.
    port: positiveIntOrDefault(process.env.REDIS_PORT, 6379),
    maxRetriesPerRequest: null, // Required by BullMQ
  };
  if (process.env.REDIS_PASSWORD) {
    connection.password = process.env.REDIS_PASSWORD;
  }
  return connection;
}

// Read fresh on every call: startEmbeddedRedisIfEnabled() rewrites
// REDIS_HOST/PORT at startup, and module-load snapshots would keep pointing
// at the pre-embedded (wrong) port. Never cache this in a module constant.
function getDefaultRedisConfig() {
  return getRedisConnection();
}

const QUEUE_NAME = 'batch-processing';

// Master strict reliability/backpressure config (single source of truth).
const JOB_RETRY_CONFIG = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000, // 1s → 2s → 4s (+ BullMQ jitter)
  },
};

// Backpressure: refuse new batches when durable work piles up.
// Validated via shared config helper — NaN/negative/zero fall back safely
// instead of silently disabling the comparison.
function getMaxQueueDepth() {
  return positiveIntOrDefault(process.env.MAX_QUEUE_DEPTH, 100);
}

let queue = null;
let queueEvents = null;

/**
 * Initializes the BullMQ queue for batch processing.
 *
 * @param {object} [redisConfig] - Redis connection options override
 * @returns {Queue} The BullMQ queue instance
 */
function initQueue(redisConfig) {
  if (queue) return queue;

  const connection = redisConfig || getDefaultRedisConfig();

  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Retry configuration: exponential backoff + jitter
      attempts: JOB_RETRY_CONFIG.attempts,
      backoff: JOB_RETRY_CONFIG.backoff,
      // Remove completed jobs after 24 hours to prevent unbounded growth
      removeOnComplete: {
        age: 86400,  // 24 hours in seconds
        count: 1000, // Keep at most 1000 completed jobs
      },
      // Keep failed jobs for debugging (dead-letter equivalent)
      removeOnFail: {
        age: 604800,  // 7 days
        count: 5000,
      },
    },
  });

  logger.info('Queue initialized', {
    name: QUEUE_NAME,
    redis: typeof connection === 'string' ? 'REDIS_URL' : `${connection.host}:${connection.port}`,
  });

  return queue;
}

/**
 * Adds a batch processing job to the queue.
 * The payload is intentionally small — just the batchId.
 * The worker loads the batch input from temporary Redis state.
 *
 * @param {string} batchId - The batch ID to process
 * @param {object} [options] - Additional job options
 * @returns {Promise<object>} The created job
 */
async function addBatchJob(batchId, options = {}) {
  if (!queue) {
    throw new Error('Queue not initialized. Call initQueue() first.');
  }

  const job = await queue.add(
    'process-batch',
    { batchId },
    {
      // Use batchId as the job ID for deduplication at queue level
      jobId: `batch-${batchId}`,
      ...options,
    }
  );

  logger.info('Batch job added to queue', {
    jobId: job.id,
    batchId,
    queueName: QUEUE_NAME,
  });

  return job;
}

/**
 * Returns queue health information.
 * Useful for readiness checks and monitoring.
 *
 * @returns {Promise<object>} Queue stats
 */
async function getQueueHealth() {
  if (!queue) {
    return { connected: false, error: 'Queue not initialized' };
  }

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      connected: true,
      name: QUEUE_NAME,
      counts: { waiting, active, completed, failed, delayed },
      depth: waiting + active + delayed,
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

/**
 * Gracefully closes the queue connection.
 */
async function closeQueue() {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
    logger.info('Queue connection closed');
  }
}

/**
 * Returns the BullMQ job for a batch, or null when absent/uninitialized.
 * Job IDs are deterministic (`batch-{batchId}`), which is what makes
 * orphan recovery and duplicate detection possible.
 */
async function getBatchJob(batchId) {
  if (!queue) return null;
  try {
    return (await queue.getJob(`batch-${batchId}`)) || null;
  } catch {
    return null;
  }
}

/**
 * Returns the raw queue instance (for testing/worker creation).
 */
function getQueue() {
  return queue;
}

module.exports = {
  QUEUE_NAME,
  JOB_RETRY_CONFIG,
  getMaxQueueDepth,
  getRedisConnection,
  getDefaultRedisConfig,
  initQueue,
  addBatchJob,
  getBatchJob,
  getQueueHealth,
  closeQueue,
  getQueue,
};
