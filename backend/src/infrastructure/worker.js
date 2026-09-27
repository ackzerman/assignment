/**
 * Batch Processing Worker — BullMQ Consumer
 *
 * Consumes batch jobs from the queue and processes parcels using
 * the SAME domain core (validation → routing engine → rules)
 * as the synchronous single-parcel endpoint.
 *
 * Architecture (Redis chunk checkpointing, no database):
 *   Queue { batchId } → Worker → Load batch state from Redis
 *     → Atomically claim next chunk (unique ownership token per claim;
 *       stale locks expire and become reclaimable) → Validate → Route
 *     → Ownership-checked checkpoint (commits ONLY if our token still
 *       holds the lock) → Progress derived from checkpoint state
 *     → Claim next chunk
 *
 * Two layers:
 * - Chunk checkpoints = recovery optimization. A retry SKIPS DONE chunks,
 *   limiting recomputation to the unfinished chunk (crash window).
 * - Parcel-level idempotency (HSETNX per parcel result) = final correctness
 *   safeguard: a retried chunk can never duplicate authoritative results.
 *
 * Duplicate computation is minimized but not mathematically eliminated under
 * a crash occurring between computation and checkpoint.
 *
 * CRITICAL: This worker does NOT contain any business logic.
 * It is purely an orchestrator.
 */

const { Worker } = require('bullmq');
const { randomUUID } = require('crypto');
const { validateParcelInput } = require('../domain/validation');
const { routeParcel } = require('../domain/routingEngine');
// Namespace import so tests can inject failures via jest.spyOn(store, ...).
const store = require('./batchStore');
const { logger } = require('../observability/logger');
const { recordRouting, recordFailure, recordBatch, recordError, recordJobCompleted, recordJobFailed, recordJobRetry, workerJobStarted, workerJobFinished } = require('../observability/metrics');
const { QUEUE_NAME, DEFAULT_REDIS_CONFIG } = require('./queue');

const DEFAULT_CHUNK_SIZE = parseInt(process.env.BATCH_CHUNK_SIZE || '500', 10) || 500;
const DEFAULT_CHUNK_LEASE_MS = parseInt(process.env.CHUNK_LEASE_MS || '300000', 10) || 300000;

let worker = null;

/**
 * Creates and starts the batch processing worker.
 *
 * @param {object} [options]
 * @param {object} [options.connection] - Redis connection config
 * @param {number} [options.concurrency] - Number of concurrent jobs (default: 1)
 * @returns {Worker} The BullMQ worker instance
 */
function createWorker(options = {}) {
  const connection = options.connection || DEFAULT_REDIS_CONFIG;
  const concurrency = options.concurrency || 1;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Increment/decrement (not set 1/0) so concurrent jobs are counted correctly.
      workerJobStarted();
      const started = Date.now();
      try {
        const result = await processBatchJob(job, { leaseMs: DEFAULT_CHUNK_LEASE_MS });
        recordJobCompleted(Date.now() - started);
        return result;
      } finally {
        workerJobFinished();
      }
    },
    {
      connection,
      concurrency,
      // Lock duration: how long the worker can hold a job before it's retried
      lockDuration: 300000, // 5 minutes
      // Stalled job check interval
      stalledInterval: 30000, // 30 seconds
    }
  );

  // --- Worker event handlers ---

  worker.on('completed', (job, result) => {
    logger.info('Batch job completed', {
      jobId: job.id,
      batchId: job.data.batchId,
      workerId: worker.id,
      ...result,
    });
  });

  worker.on('failed', (job, err) => handleJobFailed(job, err));

  worker.on('error', (err) => {
    logger.error('Worker error', {
      workerId: worker.id,
      error: err.message,
    });
  });

  logger.info('Batch worker started', {
    workerId: worker.id,
    queueName: QUEUE_NAME,
    concurrency,
  });

  return worker;
}

/**
 * Handles a BullMQ job failure (extracted for testability).
 *
 * - Non-terminal failures: counted as retries (BullMQ will retry).
 * - Exhausted retries: the batch is marked FAILED with a SAFE, generic
 *   public message. The raw internal error is logged here for diagnostics
 *   but NEVER written to batch state, so GET /api/batches/:batchId can only
 *   ever expose the safe text. The throw itself still propagates through
 *   BullMQ, preserving retry/backoff behavior.
 */
function handleJobFailed(job, err) {
  logger.error('Batch job failed', {
    jobId: job?.id,
    batchId: job?.data?.batchId,
    workerId: worker?.id,
    error: err.message,
    attemptsMade: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
  });

  // Retries: transient attempts are retried by BullMQ; count them.
  const maxAttempts = job?.opts?.attempts || 3;
  if (job && (job.attemptsMade || 0) < maxAttempts) {
    recordJobRetry();
  }

  // If all retries exhausted, mark batch as FAILED in Redis state.
  if (job && job.attemptsMade >= (job.opts?.attempts || 3)) {
    recordJobFailed();
    store.markBatchFailed(
      job.data.batchId,
      `Batch processing failed after ${job.attemptsMade} attempts.`,
    ).catch((storeErr) => {
      logger.error('Failed to mark batch FAILED after job failure', {
        batchId: job.data.batchId,
        error: storeErr.message,
      });
    });
  }
}

/**
 * Core batch job processor with Redis chunk-level checkpointing (see header).
 *
 * Error semantics:
 * - EXPECTED parcel failures (malformed input → validation errors) become
 *   per-parcel 'invalid' results; the batch continues and finalizes as
 *   COMPLETED_WITH_ERRORS. Internal details are never exposed: unexpected
 *   messages are replaced with a safe representation.
 * - UNEXPECTED failures (Redis outage, routing-engine bug, programming
 *   exceptions) propagate: the active chunk claim is released back to
 *   PENDING, the system error metric is recorded, and the throw lets the
 *   BullMQ retry mechanism work. They are NEVER converted into parcel rows.
 *
 * @param {object} job - BullMQ job with data { batchId }
 * @param {object} [options]
 * @param {number} [options.leaseMs] - Chunk claim lease duration
 * @param {string} [options.workerId] - Identity recorded on claimed chunks
 * @returns {object} Processing summary (batch-level totals from Redis state)
 */
async function processBatchJob(job, options = {}) {
  const { batchId } = job.data;
  const leaseMs = options.leaseMs ?? DEFAULT_CHUNK_LEASE_MS;
  const executionId = options.workerId || `${job.id || 'local'}:${randomUUID().split('-')[0]}`;

  logger.info('Processing batch job', {
    jobId: job.id,
    batchId,
    workerId: worker?.id || executionId,
  });

  // Step 1: Load batch input + state from Redis (queue carries identity only).
  const parcels = await store.getBatchInput(batchId);
  if (!parcels) {
    throw new Error(`Batch state not found for batchId: ${batchId}`);
  }

  const batch = await store.getBatchState(batchId);
  if (!batch) {
    throw new Error(`Batch state not found for batchId: ${batchId}`);
  }

  // Step 2: Mark batch as PROCESSING on first execution only.
  if (batch.status === 'QUEUED') {
    await store.setBatchStatus(batchId, 'PROCESSING', {
      startedAt: new Date().toISOString(),
    });
  }

  // Step 3: Claim → process → checkpoint loop. DONE chunks are skipped, so a
  // retry never recomputes checkpointed work. Unexpected failures release our
  // active claim and propagate (see catch).
  let chunksCompletedByThisExecution = 0;
  let consecutiveStaleCheckpoints = 0;
  let activeChunk = null;

  // Bound consecutive stale rejections: a healthy lease always outlives one
  // chunk's processing, so repeated staleness means CHUNK_LEASE_MS is
  // misconfigured shorter than chunk processing time — fail loudly instead
  // of spinning claim→reject forever.
  const maxStale = Math.max(1, (await store.getChunkProgress(batchId)).totalChunks) * 3;

  try {
    for (;;) {
      const chunk = await store.claimNextChunk(batchId, executionId, leaseMs);
      if (!chunk) break;
      activeChunk = chunk;

      const chunkResults = [];
      let chunkSuccessful = 0;
      let chunkFailed = 0;

      // Step 4: Process each parcel through the shared domain core (in memory).
      // EXPECTED failures (invalid input) are returned as 'invalid' results
      // and counted below. UNEXPECTED exceptions (Redis outage, engine bug)
      // propagate to the catch — never converted into parcel rows.
      for (let index = chunk.startIndex; index < chunk.endIndex; index++) {
        const parcelData = parcels[index];
        const parcelId = parcelData?.parcelId || `P${index + 1}`;

        const result = processOneParcel(batchId, parcelId, parcelData, index);
        chunkResults.push(result);

        if (result.status === 'routed') {
          chunkSuccessful++;
          // Record metrics for observability
          recordRouting(result.department, result.approvals || []);
        } else {
          chunkFailed++;
          recordFailure();
        }
      }

      // Step 5: Ownership-checked checkpoint. Commits ONLY if our claim
      // token still holds the lock. If our lease expired and another worker
      // reclaimed the chunk, the checkpoint is rejected: log and move on —
      // the owning worker will complete it (no corrupt overwrite, no stolen
      // lock deletion). A crash before commit leaves the chunk reclaimable;
      // parcel-level HSETNX absorbs duplicates on recompute.
      const checkpoint = await store.checkpointChunk(
        batchId,
        chunk.chunkIndex,
        chunk.token,
        chunkResults,
        chunkSuccessful,
        chunkFailed,
      );

      if (!checkpoint.committed) {
        logger.warn('Stale checkpoint rejected; chunk owned elsewhere', {
          batchId,
          chunkIndex: chunk.chunkIndex,
        });
        activeChunk = null;
        consecutiveStaleCheckpoints++;
        if (consecutiveStaleCheckpoints > maxStale) {
          throw new Error(
            `Chunk checkpoints repeatedly rejected as stale for batch ${batchId}: ` +
            'CHUNK_LEASE_MS is likely shorter than chunk processing time.',
          );
        }
        continue;
      }
      consecutiveStaleCheckpoints = 0;

      if (checkpoint.duplicates > 0) {
        logger.warn('Duplicate parcel results absorbed by idempotency', {
          batchId,
          chunkIndex: chunk.chunkIndex,
          duplicates: checkpoint.duplicates,
        });
      }

      chunksCompletedByThisExecution++;
      activeChunk = null;

      // Update job progress for BullMQ monitoring from checkpoint-derived progress.
      const current = await store.getBatchState(batchId);
      if (job.updateProgress && current) {
        await job.updateProgress(current.progress);
      }

      // Yield to the event loop between chunks.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    // UNEXPECTED failure: release our still-held claim (ownership token, so
    // a reclaim by another worker is never disturbed) so a retry can reclaim
    // this chunk immediately. Record a system error (not a parcel failure),
    // and propagate so the queue retry mechanism works.
    if (activeChunk) {
      try {
        await store.releaseChunk(batchId, activeChunk.chunkIndex, activeChunk.token);
      } catch (releaseErr) {
        logger.warn('Failed to release chunk claim after error', {
          batchId,
          chunkIndex: activeChunk.chunkIndex,
          error: releaseErr.message,
        });
      }
    }
    recordError();
    throw err;
  }

  // Step 6: Finalize only when every chunk is DONE. If chunks remain
  // PROCESSING under another live worker, this execution returns current
  // totals without finalizing; the active worker will finalize.
  const final = await store.getBatchState(batchId);
  const { totalChunks, completedChunks } = await store.getChunkProgress(batchId);

  if (totalChunks > 0 && completedChunks === totalChunks) {
    const finalStatus = final.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    if (final.status === 'PROCESSING' || final.status === 'QUEUED') {
      await store.setBatchStatus(batchId, finalStatus, {
        completedAt: new Date().toISOString(),
      });
    }

    // Record batch metrics once per completed batch.
    recordBatch({ total: final.total, successful: final.successful, failed: final.failed });

    const summary = {
      batchId,
      status: finalStatus,
      total: final.total,
      successful: final.successful,
      failed: final.failed,
    };

    logger.info('Batch processing complete', {
      ...summary,
      workerId: worker?.id || executionId,
      jobId: job.id,
      chunksCompletedByThisExecution,
    });

    return summary;
  }

  const partial = await store.getBatchState(batchId);
  logger.info('Batch job execution yielded; chunks remain for other workers', {
    batchId,
    jobId: job.id,
    workerId: worker?.id || executionId,
    totalChunks,
    completedChunks,
    chunksCompletedByThisExecution,
  });

  return {
    batchId,
    status: partial.status,
    total: partial.total,
    successful: partial.successful,
    failed: partial.failed,
    totalChunks,
    completedChunks,
  };
}

/**
 * Processes a single parcel within a batch.
 * Uses the SAME domain functions as the synchronous single-parcel API.
 *
 * single API ───────┐
 *                   ├──> validation → routing engine → rules
 * batch worker ─────┘
 *
 * Non-object entries are malformed input (EXPECTED): they become 'invalid'
 * results. Anything thrown by validation/routing is UNEXPECTED and propagates.
 *
 * @param {string} batchId
 * @param {string} parcelId
 * @param {object} parcelData - Raw parcel input
 * @param {number} index - Position in the batch
 * @returns {object} Result for persistence
 */
function processOneParcel(batchId, parcelId, parcelData, index) {
  // Step 1: Validate — using the SAME validateParcelInput as single parcel
  const validation = validateParcelInput(parcelData);

  if (!validation.success) {
    return {
      batchId,
      parcelId,
      index,
      status: 'invalid',
      errors: validation.errors,
      inputSummary: {
        weight: parcelData?.weight,
        value: parcelData?.value,
        destinationCountry: parcelData?.destinationCountry,
      },
    };
  }

  // Step 2: Route — using the SAME routeParcel as single parcel
  const routing = routeParcel(validation.parcel);

  return {
    batchId,
    parcelId,
    index,
    status: 'routed',
    department: routing.department,
    approvals: routing.approvals,
    matchedRules: routing.matchedRules,
    reasons: routing.reasons,
    inputSummary: {
      weight: validation.parcel.weight,
      value: validation.parcel.value,
      destinationCountry: validation.parcel.destinationCountry,
    },
  };
}

/**
 * Gracefully shuts down the worker.
 * Waits for the current job to finish before closing.
 */
async function closeWorker() {
  if (worker) {
    logger.info('Worker shutting down gracefully...');
    await worker.close();
    worker = null;
    logger.info('Worker shut down');
  }
}

/**
 * Returns the worker instance (for testing/monitoring).
 */
function getWorker() {
  return worker;
}

module.exports = {
  createWorker,
  closeWorker,
  getWorker,
  handleJobFailed, // Exported for failure-path testing (no live BullMQ needed)
  processBatchJob, // Exported for integration testing (mock Redis + mock job)
  processOneParcel, // Exported for unit testing
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_LEASE_MS,
};
