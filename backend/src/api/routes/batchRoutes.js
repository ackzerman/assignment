/**
 * Batch API Routes
 *
 * Handles asynchronous batch processing:
 *   POST   /api/batches           → Create batch (202 Accepted)
 *   GET    /api/batches           → List own batches
 *   GET    /api/batches/:batchId  → Get batch status/progress
 *   GET    /api/batches/:batchId/results → Get batch results
 *
 * Flow:
 *   Client → POST /api/batches → validate batch → backpressure check
 *          → create DB record (owner) → queue job → 202
 *   Client → GET /api/batches/:batchId → ownership check → DB lookup
 *
 * Security (Master Phase 11):
 * - authOptional attaches req.user (anonymous when no API_TOKENS configured).
 * - When auth is enabled, batches are owned and cross-owner reads → 403.
 * - Single-parcel routing stays open (stateless, no durable resource to own).
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { validateBatchInput } = require('../../domain/batchProcessor');
const {
  createBatch,
  getBatch,
  getBatchResults,
  getBatchResultCount,
  listBatches,
} = require('../../infrastructure/database');
const { addBatchJob, getQueueHealth, MAX_QUEUE_DEPTH } = require('../../infrastructure/queue');
const { authOptional, isAuthEnabled } = require('../middleware/auth');
const { AppError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { setQueueDepth } = require('../../observability/metrics');

const router = express.Router();

// All batch resources are ownership-scoped.
router.use(authOptional);

/**
 * Throws 403 when the caller does not own the batch.
 * In anonymous mode (no API_TOKENS) every batch is owned by 'anonymous',
 * so this only enforces when auth is enabled.
 */
function enforceOwnership(req, batch) {
  const owner = req.user?.id || 'anonymous';
  if (isAuthEnabled() && batch.owner && batch.owner !== owner) {
    throw new AppError('Forbidden. You do not own this batch.', 403);
  }
}

/**
 * POST /api/batches
 *
 * Creates a new batch for asynchronous processing.
 * Returns 202 Accepted because processing has NOT completed yet.
 */
router.post('/', async (req, res, next) => {
  try {
    // Step 1: Validate the batch envelope
    const batchValidation = validateBatchInput(req.body);
    if (!batchValidation.valid) {
      logger.warn('Batch validation failed', {
        requestId: req.id,
        error: batchValidation.error,
      });
      throw new AppError(batchValidation.error, 400);
    }

    // Step 2: Backpressure — refuse when durable work is piling up (Master: Backpressure).
    // Fail-open when the queue is unavailable (dev/test without Redis): log and continue.
    try {
      const health = await getQueueHealth();
      if (health.connected) {
        setQueueDepth(health.depth || 0);
        if ((health.depth || 0) >= MAX_QUEUE_DEPTH) {
          logger.warn('Batch rejected due to backpressure', {
            requestId: req.id,
            depth: health.depth,
            max: MAX_QUEUE_DEPTH,
          });
          res.setHeader('Retry-After', '30');
          throw new AppError(
            `Server is busy (queue depth ${health.depth}). Try again later.`,
            429,
          );
        }
      }
    } catch (err) {
      if (err.statusCode === 429) throw err;
      logger.warn('Queue health check unavailable, accepting batch anyway', {
        requestId: req.id,
        error: err.message,
      });
    }

    // Step 3: Generate a unique batch ID
    const batchId = `BATCH-${randomUUID().split('-')[0]}`;
    const parcels = batchValidation.parcels;
    const owner = req.user?.id || 'anonymous';

    // Assign parcel IDs if not provided
    const parcelsWithIds = parcels.map((p, i) => ({
      ...p,
      parcelId: p.parcelId || `P${i + 1}`,
    }));

    logger.info('Creating batch', {
      requestId: req.id,
      batchId,
      parcelCount: parcels.length,
      owner,
    });

    // Step 4: Create batch record in DB (durable state, with owner)
    createBatch(batchId, parcels.length, parcelsWithIds, owner);

    // Step 5: Add job to queue (durable work)
    // Payload is small: just { batchId }. Worker reads data from DB.
    await addBatchJob(batchId);

    logger.info('Batch queued for processing', {
      requestId: req.id,
      batchId,
      parcelCount: parcels.length,
      owner,
    });

    // Step 6: Return 202 Accepted
    res.status(202).json({
      status: 'accepted',
      data: {
        batchId,
        status: 'QUEUED',
        total: parcels.length,
        message: `Batch ${batchId} has been accepted for processing. Use GET /api/batches/${batchId} to track progress.`,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/batches
 *
 * Lists batches (most recent first). When auth is enabled, only own batches.
 * Optional query param: ?status=PROCESSING
 */
router.get('/', (req, res, next) => {
  try {
    const { status, limit } = req.query;
    const owner = req.user?.id || 'anonymous';
    const batches = listBatches({
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      owner: isAuthEnabled() ? owner : undefined,
    });

    res.status(200).json({
      status: 'success',
      data: { batches },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/batches/:batchId
 *
 * Returns current batch status and progress.
 * Frontend polls this endpoint to show the progress bar.
 */
router.get('/:batchId', (req, res, next) => {
  try {
    const { batchId } = req.params;
    const batch = getBatch(batchId);

    if (!batch) {
      throw new AppError(`Batch '${batchId}' not found.`, 404);
    }
    enforceOwnership(req, batch);

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
 * Returns the persisted routing results for a completed batch.
 * Supports pagination via ?limit=100&offset=0
 */
router.get('/:batchId/results', (req, res, next) => {
  try {
    const { batchId } = req.params;
    const batch = getBatch(batchId);

    if (!batch) {
      throw new AppError(`Batch '${batchId}' not found.`, 404);
    }
    enforceOwnership(req, batch);

    const { limit, offset } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? parseInt(offset, 10) : undefined;

    const results = getBatchResults(batchId, {
      limit: parsedLimit,
      offset: parsedOffset,
    });
    const totalResults = getBatchResultCount(batchId);

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
