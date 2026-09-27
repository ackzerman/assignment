/**
 * Batch API Routes (Redis-backed, anonymous/public)
 *
 *   POST   /api/batches           → Create batch (202 Accepted)
 *   GET    /api/batches/:batchId  → Get batch status/progress
 *   GET    /api/batches/:batchId/results → Get batch results (paginated)
 *
 * Flow:
 *   Client → POST /api/batches → validate batch → verify Redis →
 *          create temporary Redis state → queue job → 202
 *   Client → GET /api/batches/:batchId → poll Redis state for progress
 *   Client → GET /api/batches/:batchId/results → fetch temporary results
 *
 * There is intentionally NO authentication, NO ownership, and NO permanent
 * batch history: batch state carries a TTL and expires after the session.
 * The API layer is a thin HTTP adapter. No business logic lives here.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { validateBatchInput } = require('../../domain/batchProcessor');
const store = require('../../infrastructure/batchStore');
// Namespace import so tests can control availability via jest.spyOn(redis, ...).
const redis = require('../../infrastructure/redis');
const { addBatchJob, getQueueHealth, MAX_QUEUE_DEPTH } = require('../../infrastructure/queue');
const { AppError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { setQueueDepth } = require('../../observability/metrics');

const router = express.Router();

/**
 * Canonical batch creation path: the single batch implementation.
 *
 * Steps: verify Redis → backpressure check → create temporary Redis state
 * (meta + input + PENDING chunk checkpoints) → enqueue BullMQ job carrying
 * { batchId } only.
 *
 * Redis/queue failure window: if Redis is unavailable, fail fast with 503
 * before creating anything. If queue submission fails after state was
 * created, delete the temporary state (never leave a falsely QUEUED batch)
 * and throw 503.
 *
 * @param {Array} parcels - Validated parcel inputs
 * @param {object} [options]
 * @param {string} [options.requestId] - Request ID for log correlation
 * @returns {Promise<{ batchId: string, status: string, total: number }>}
 * @throws {AppError} 429 on backpressure, 503 when Redis/queue unavailable
 */
async function enqueueBatch(parcels, { requestId } = {}) {
  // Step 1: Redis is the authoritative temporary state — fail fast when down.
  if (!(await redis.pingRedis())) {
    logger.error('Batch rejected: Redis unavailable', { requestId });
    throw new AppError('Batch processing is temporarily unavailable. Please try again later.', 503);
  }

  // Step 2: Backpressure — refuse when durable work is piling up.
  try {
    const health = await getQueueHealth();
    if (health.connected) {
      setQueueDepth(health.depth || 0);
      if ((health.depth || 0) >= MAX_QUEUE_DEPTH) {
        logger.warn('Batch rejected due to backpressure', {
          requestId,
          depth: health.depth,
          max: MAX_QUEUE_DEPTH,
        });
        throw new AppError(
          `Server is busy (queue depth ${health.depth}). Try again later.`,
          429,
        );
      }
    }
  } catch (err) {
    if (err.statusCode === 429) throw err;
    logger.warn('Queue health check unavailable, accepting batch anyway', {
      requestId,
      error: err.message,
    });
  }

  // Step 3: Strong unpredictable batch identifier (full UUID, not truncated).
  const batchId = `BATCH-${randomUUID()}`;

  // Assign parcel IDs if not provided (duplicates already rejected by validation)
  const parcelsWithIds = parcels.map((p, i) => ({
    ...p,
    parcelId: p.parcelId || `P${i + 1}`,
  }));

  logger.info('Creating batch', {
    requestId,
    batchId,
    parcelCount: parcels.length,
  });

  // Step 4: Create temporary Redis state (meta + input + chunk checkpoints).
  await store.createBatchState(batchId, parcelsWithIds);

  // Step 5: Add job to queue (durable work). Payload is small: just { batchId }.
  try {
    await addBatchJob(batchId);
  } catch (err) {
    // State was created but the queue did not accept the job: delete the
    // temporary state so no falsely QUEUED batch lingers, then report failure.
    try {
      await store.deleteBatch(batchId);
    } catch (cleanupErr) {
      logger.error('Failed to clean up batch state after queue submission failure', {
        requestId,
        batchId,
        error: cleanupErr.message,
      });
    }
    logger.error('Batch queue submission failed', {
      requestId,
      batchId,
      error: err.message,
    });
    throw new AppError(
      'Batch could not be queued for processing. Please try again later.',
      503,
    );
  }

  logger.info('Batch queued for processing', {
    requestId,
    batchId,
    parcelCount: parcels.length,
  });

  return { batchId, status: 'QUEUED', total: parcels.length };
}

/**
 * POST /api/batches
 *
 * Creates a new batch for asynchronous processing.
 * Returns 202 Accepted because processing has NOT completed yet.
 */
router.post('/', async (req, res, next) => {
  try {
    // Validate the batch envelope (incl. duplicate parcel IDs)
    const batchValidation = validateBatchInput(req.body);
    if (!batchValidation.valid) {
      logger.warn('Batch validation failed', {
        requestId: req.id,
        error: batchValidation.error,
      });
      throw new AppError(batchValidation.error, 400);
    }

    const created = await enqueueBatch(batchValidation.parcels, {
      requestId: req.id,
    });

    res.status(202).json({
      status: 'accepted',
      data: {
        ...created,
        message: `Batch ${created.batchId} has been accepted for processing. Use GET /api/batches/${created.batchId} to track progress.`,
      },
    });
  } catch (error) {
    if (error.statusCode === 429) res.setHeader('Retry-After', '30');
    next(error);
  }
});

/**
 * GET /api/batches/:batchId
 *
 * Returns current batch status and progress from temporary Redis state.
 * Frontend polls this endpoint to show the progress bar.
 * 404 when the batch is unknown or its TTL has expired.
 */
router.get('/:batchId', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const batch = await store.getBatchState(batchId);

    if (!batch) {
      throw new AppError(`Batch '${batchId}' not found or expired.`, 404);
    }

    res.status(200).json({
      status: 'success',
      data: batch,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/batches/:batchId/results
 *
 * Returns the temporary routing results for the active processing session.
 * Paginated via ?limit=100&offset=0 (limit is capped server-side).
 */
router.get('/:batchId/results', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const batch = await store.getBatchState(batchId);

    if (!batch) {
      throw new AppError(`Batch '${batchId}' not found or expired.`, 404);
    }

    const { limit, offset } = req.query;
    const results = await store.getBatchResults(batchId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    const totalResults = await store.getBatchResultCount(batchId);

    res.status(200).json({
      status: 'success',
      data: {
        batchId,
        batchStatus: batch.status,
        total: batch.total,
        successful: batch.successful,
        failed: batch.failed,
        resultCount: totalResults,
        results,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
