/**
 * Batch Processing Worker — BullMQ Consumer
 *
 * Consumes batch jobs from the queue and processes parcels using
 * the SAME domain core (validation → routing engine → rules)
 * as the synchronous single-parcel endpoint.
 *
 * Architecture (chunk checkpointing):
 *   Queue { batchId } → Worker → Load batch from DB
 *     → Atomically claim next PENDING chunk (or stale PROCESSING whose
 *       lease expired) → Validate (domain) → Route (domain)
 *     → Bulk persist results + mark chunk DONE in ONE transaction
 *     → Update progress → Claim next chunk
 *
 * Two durability layers:
 * - Chunk checkpoints = recovery optimization. A retry SKIPS DONE chunks,
 *   limiting recomputation to the unfinished chunk (crash window).
 * - Parcel-level idempotency (INSERT OR IGNORE on UNIQUE(batch_id, parcel_id))
 *   = final correctness safeguard against duplicate persisted results.
 *
 * CRITICAL: This worker does NOT contain any business logic.
 * It is purely an orchestrator.
 */

const { Worker } = require('bullmq');
const { randomUUID } = require('crypto');
const { validateParcelInput } = require('../domain/validation');
const { routeParcel } = require('../domain/routingEngine');
// Namespace import so tests can inject failures via jest.spyOn(db, ...).
const db = require('./database');
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
 * @param {number} [options.chunkSize] - Parcels per checkpoint chunk (default: BATCH_CHUNK_SIZE or 500)
 * @returns {Worker} The BullMQ worker instance
 */
function createWorker(options = {}) {
  const connection = options.connection || DEFAULT_REDIS_CONFIG;
  const concurrency = options.concurrency || 1;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Increment/decrement (not set 1/0) so concurrent jobs are counted correctly.
      workerJobStarted();
      const started = Date.now();
      try {
        const result = await processBatchJob(job, chunkSize, { leaseMs: DEFAULT_CHUNK_LEASE_MS });
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

  worker.on('failed', (job, err) => {
    logger.error('Batch job failed', {
      jobId: job?.id,
      batchId: job?.data?.batchId,
      workerId: worker.id,
      error: err.message,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
    });

    // Master retries: transient attempts are retried by BullMQ; count them.
    const maxAttempts = job?.opts?.attempts || 3;
    if (job && (job.attemptsMade || 0) < maxAttempts) {
      recordJobRetry();
    }

    // If all retries exhausted, mark batch as FAILED
    if (job && job.attemptsMade >= (job.opts?.attempts || 3)) {
      recordJobFailed();
      try {
        db.updateBatchStatus(job.data.batchId, 'FAILED', {
          completedAt: new Date().toISOString(),
          error: `Processing failed after ${job.attemptsMade} attempts: ${err.message}`,
        });
      } catch (dbErr) {
        logger.error('Failed to update batch status after job failure', {
          batchId: job.data.batchId,
          error: dbErr.message,
        });
      }
    }
  });

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
    chunkSize,
  });

  return worker;
}

/**
 * Core batch job processor with chunk-level checkpointing (see header).
 *
 * Error semantics:
 * - EXPECTED parcel failures (invalid input → validateParcelInput returns
 *   errors) become per-parcel 'invalid' results; the batch continues and
 *   finalizes as COMPLETED_WITH_ERRORS.
 * - UNEXPECTED failures (database outage, routing-engine bug, programming
 *   exceptions) propagate: the active chunk claim is released back to
 *   PENDING, the system error metric is recorded, and the throw lets the
 *   BullMQ retry mechanism work. They are NEVER converted into parcel rows.
 *
 * @param {object} job - BullMQ job with data { batchId }
 * @param {number} [chunkSize] - Used only to create checkpoints for legacy
 *   batches that predate checkpointing; otherwise stored chunks rule.
 * @param {object} [options]
 * @param {number} [options.leaseMs] - Chunk claim lease duration
 * @param {string} [options.workerId] - Identity recorded on claimed chunks
 * @returns {object} Processing summary (batch-level totals from the DB)
 */
async function processBatchJob(job, chunkSize = DEFAULT_CHUNK_SIZE, options = {}) {
  const { batchId } = job.data;
  const leaseMs = options.leaseMs ?? DEFAULT_CHUNK_LEASE_MS;
  const executionId = options.workerId || `${job.id || 'local'}:${randomUUID().split('-')[0]}`;

  logger.info('Processing batch job', {
    jobId: job.id,
    batchId,
    workerId: worker?.id || executionId,
  });

  // Step 1: Load batch data from DB
  const parcels = db.getBatchData(batchId);
  if (!parcels) {
    throw new Error(`Batch data not found for batchId: ${batchId}`);
  }

  const batch = db.getBatch(batchId);
  if (!batch) {
    throw new Error(`Batch record not found for batchId: ${batchId}`);
  }

  // Step 2: Mark batch as PROCESSING on first execution only.
  if (batch.status === 'QUEUED') {
    db.updateBatchStatus(batchId, 'PROCESSING', {
      startedAt: new Date().toISOString(),
    });
  }

  // Checkpoints for legacy batches; normally pre-created at batch creation.
  db.ensureChunksForBatch(batchId, parcels.length, chunkSize);

  // Step 3: Claim → process → checkpoint loop. DONE chunks are skipped.
  // Unexpected failures release our active claim and propagate (see catch).
  let chunksCompletedByThisExecution = 0;
  let activeChunk = null;

  try {
    for (;;) {
      const chunk = db.claimNextChunk(batchId, executionId, leaseMs);
      if (!chunk) break;
      activeChunk = chunk;

      const chunkResults = [];
      let chunkSuccessful = 0;
      let chunkFailed = 0;

      // Step 4: Process each parcel through the shared domain core (in memory).
      // EXPECTED failures (invalid input) are returned as 'invalid' results
      // and counted below. UNEXPECTED exceptions (DB outage, engine bug)
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

      // Step 5: Bulk persist + mark DONE atomically.
      // If this throws (crash), the chunk stays PROCESSING with a live lease
      // (another execution recovers it after expiry) and parcel-level
      // idempotency absorbs any partially persisted rows on recompute.
      const { duplicates } = db.persistChunkAndMarkDone(
        batchId,
        chunk.chunkIndex,
        chunkResults,
        chunkSuccessful,
        chunkFailed,
      );

      if (duplicates > 0) {
        logger.warn('Duplicate parcel results detected (idempotency)', {
          batchId,
          chunkIndex: chunk.chunkIndex,
          duplicates,
        });
      }

      chunksCompletedByThisExecution++;
      activeChunk = null;

      // Update job progress for BullMQ monitoring from DB-derived progress.
      const current = db.getBatch(batchId);
      if (job.updateProgress && current) {
        await job.updateProgress(current.progress);
      }

      // Yield to the event loop between chunks.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    // UNEXPECTED failure: release our still-held claim so a retry can reclaim
    // this chunk immediately (no-op if already DONE or owned elsewhere),
    // record a system error (not a parcel failure), and propagate so the
    // queue retry mechanism works.
    if (activeChunk) {
      try {
        db.releaseChunk(batchId, activeChunk.chunkIndex, executionId);
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
  const final = db.getBatch(batchId);
  const { totalChunks, completedChunks } = db.getChunkProgress(batchId);

  if (totalChunks > 0 && completedChunks === totalChunks) {
    const finalStatus = final.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    if (final.status === 'PROCESSING' || final.status === 'QUEUED') {
      db.updateBatchStatus(batchId, finalStatus, {
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

  const partial = db.getBatch(batchId);
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
  processBatchJob, // Exported for integration testing (in-memory DB + mock job)
  processOneParcel, // Exported for unit testing
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_LEASE_MS,
};
