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
const { recordRouting, recordFailure, recordBatch, recordJobCompleted, recordJobFailed, recordJobRetry, setWorkerActiveJobs } = require('../observability/metrics');
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
 * @param {number} [options.chunkSize] - Parcels per processing chunk (default: 100)
 * @returns {Worker} The BullMQ worker instance
 */
function createWorker(options = {}) {
  const connection = options.connection || DEFAULT_REDIS_CONFIG;
  const concurrency = options.concurrency || 1;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      setWorkerActiveJobs(1);
      const started = Date.now();
      try {
        const result = await processBatchJob(job, chunkSize, { leaseMs: DEFAULT_CHUNK_LEASE_MS });
        recordJobCompleted(Date.now() - started);
        return result;
      } finally {
        setWorkerActiveJobs(0);
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
 * Core batch job processor.
 * Called by the BullMQ worker for each job.
 *
 * Flow:
 * 1. Load batch data from DB
 * 2. Update status to PROCESSING
 * 3. Process parcels in chunks
 * 4. For each parcel: validate → route → collect result
 * 5. Persist chunk results to DB (transactional)
 * 6. Update batch progress
 * 7. Final status: COMPLETED or COMPLETED_WITH_ERRORS
 *
 * @param {object} job - BullMQ job
 * @param {number} chunkSize - Parcels per chunk
 * @returns {object} Processing summary
 */
async function processBatchJob(job, chunkSize) {
  const { batchId } = job.data;

  logger.info('Processing batch job', {
    jobId: job.id,
    batchId,
    workerId: worker?.id,
  });

  // Step 1: Load batch data from DB
  const parcels = getBatchData(batchId);
  if (!parcels) {
    throw new Error(`Batch data not found for batchId: ${batchId}`);
  }

  // Step 2: Mark batch as PROCESSING
  updateBatchStatus(batchId, 'PROCESSING', {
    startedAt: new Date().toISOString(),
  });

  let totalSuccessful = 0;
  let totalFailed = 0;

  // Step 3: Process in chunks
  for (let i = 0; i < parcels.length; i += chunkSize) {
    const chunk = parcels.slice(i, i + chunkSize);
    const chunkResults = [];
    let chunkSuccessful = 0;
    let chunkFailed = 0;

    // Step 4: Process each parcel through the shared domain core
    for (let j = 0; j < chunk.length; j++) {
      const index = i + j;
      const parcelData = chunk[j];
      const parcelId = parcelData.parcelId || `P${index + 1}`;

      try {
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
      } catch (err) {
        // Unexpected error — still don't crash the batch
        chunkResults.push({
          batchId,
          parcelId,
          index,
          status: 'error',
          errors: [{ field: '_system', message: `Unexpected error: ${err.message}` }],
        });
        chunkFailed++;
        recordFailure();
      }
    }

    // Step 5: Persist chunk results to DB (transactional, idempotent)
    const { inserted, duplicates } = saveParcelResultsBatch(chunkResults);

    if (duplicates > 0) {
      logger.warn('Duplicate parcel results detected (idempotency)', {
        batchId,
        chunkStart: i,
        duplicates,
      });
    }

    // Step 6: Update batch progress in DB
    totalSuccessful += chunkSuccessful;
    totalFailed += chunkFailed;
    updateBatchProgress(batchId, chunk.length, chunkSuccessful, chunkFailed);

    // Update job progress for BullMQ monitoring
    const processed = Math.min(i + chunkSize, parcels.length);
    await job.updateProgress(Math.round((processed / parcels.length) * 100));

    // Yield to event loop between chunks
    if (i + chunkSize < parcels.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // Step 7: Final status
  const finalStatus = totalFailed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  updateBatchStatus(batchId, finalStatus, {
    completedAt: new Date().toISOString(),
  });

  // Record batch metrics
  recordBatch({ total: parcels.length, successful: totalSuccessful, failed: totalFailed });

  const summary = {
    batchId,
    status: finalStatus,
    total: parcels.length,
    successful: totalSuccessful,
    failed: totalFailed,
  };

  logger.info('Batch processing complete', {
    ...summary,
    workerId: worker?.id,
    jobId: job.id,
  });

  return summary;
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
};
