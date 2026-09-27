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
const { validateBatchInput, assignParcelIds, findDuplicateParcelId } = require('../../domain/batchProcessor');
const store = require('../../infrastructure/batchStore');
// Namespace import so tests can control availability via jest.spyOn(redis, ...).
const redis = require('../../infrastructure/redis');
const { addBatchJob, getQueueHealth, getMaxQueueDepth } = require('../../infrastructure/queue');
const { AppError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { setQueueDepth } = require('../../observability/metrics');
const { createPollingRateLimiter } = require('../middleware/security');

const router = express.Router();

// Dedicated polling budget, separate from interactive traffic: legitimate
// status polling (~1/sec for minutes) must survive, tight loops still 429.
// (The general API limiter skips these paths; see isBatchPollRequest.)
const pollingLimiter = createPollingRateLimiter();

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
  // The limit is read per-request (not cached) so config changes apply
  // without restarts in long-lived processes.
  const maxQueueDepth = getMaxQueueDepth();
  try {
    const health = await getQueueHealth();
    if (health.connected) {
      setQueueDepth(health.depth || 0);
      if ((health.depth || 0) >= maxQueueDepth) {
        logger.warn('Batch rejected due to backpressure', {
          requestId,
          depth: health.depth,
          max: maxQueueDepth,
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

  // Generate IDs first, then enforce uniqueness on the FINAL representation:
  // every parcel in the batch must have a unique parcelId, so a generated
  // P{N} colliding with an explicit "P{N}" is rejected, not silently merged.
  const parcelsWithIds = assignParcelIds(parcels);
  const duplicateError = findDuplicateParcelId(parcelsWithIds);
  if (duplicateError) {
    logger.warn('Batch validation failed', {
      requestId,
      error: duplicateError,
    });
    throw new AppError(duplicateError, 400);
  }

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
 *
 * Idempotency-Key (optional request header): retries carrying the same key
 * and identical body receive the ORIGINAL batch identity (202) instead of
 * creating a duplicate. Same key + different body → 409. Keys expire with
 * batch state (temporary, never permanent).
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

    const idemKey = readIdempotencyKey(req);
    if (idemKey && idemKey.error) {
      throw new AppError(idemKey.error, 400);
    }

    let idemClaimed = false;
    if (idemKey) {
      const replay = await resolveIdempotentSubmission(idemKey.key, batchValidation.parcels, req.id);
      if (replay.replay) {
        return res.status(202).json({
          status: 'accepted',
          data: {
            batchId: replay.batchId,
            status: replay.batchStatus,
            total: replay.total,
            deduplicated: true,
            message: `Batch ${replay.batchId} has been accepted for processing. Use GET /api/batches/${replay.batchId} to track progress.`,
          },
        });
      }
      idemClaimed = true;
    }

    let created;
    try {
      created = await enqueueBatch(batchValidation.parcels, {
        requestId: req.id,
      });
    } catch (error) {
      // Our claim must not block an honest retry of the same key.
      if (idemClaimed) {
        await store.deleteIdempotencyKey(idemKey.key).catch(() => {});
      }
      throw error;
    }

    if (idemClaimed) {
      await store.setIdempotencyRecord(
        idemKey.key,
        {
          status: 'complete',
          batchId: created.batchId,
          bodyHash: store.hashParcelPayload(batchValidation.parcels),
        },
        store.getBatchTTLSeconds(),
      ).catch((err) => {
        // Mapping failure only loses replayability, never correctness:
        // the batch itself was created and queued normally.
        logger.warn('Failed to store idempotency mapping', {
          requestId: req.id,
          batchId: created.batchId,
          error: err.message,
        });
      });
    }

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
 * Reads and validates the optional Idempotency-Key request header.
 * Returns null (absent), { key } (usable), or { error } (reject with 400).
 * The key value itself is never logged (client-supplied secret-ish token).
 */
function readIdempotencyKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    return { error: 'Idempotency-Key must be a single string value.' };
  }
  const key = raw.trim();
  if (!key) {
    return { error: 'Idempotency-Key must not be empty.' };
  }
  if (key.length > 256) {
    return { error: 'Idempotency-Key must be at most 256 characters.' };
  }
  return { key };
}

/**
 * Resolves an idempotent submission attempt.
 *
 * - No record → claims the key for this caller ({ replay: false }).
 * - Pending record (another request in flight) → throws 409, retry later.
 * - Complete record, same body → returns the original batch ({ replay: true }).
 * - Complete record, different body → throws 409 conflict.
 * - Complete record but batch state gone → deletes the stale mapping and
 *   retries the claim loop (bounded) so the retry proceeds as new work.
 */
async function resolveIdempotentSubmission(key, parcels, requestId) {
  const bodyHash = store.hashParcelPayload(parcels);
  const ttl = store.getBatchTTLSeconds();

  for (let attempt = 0; attempt < 3; attempt++) {
    const record = await store.getIdempotencyRecord(key);

    if (!record) {
      if (await store.claimIdempotencyKey(key, ttl)) {
        return { replay: false };
      }
      continue; // Lost a claim race: re-read and handle the winner's record.
    }

    if (!record.batchId) {
      throw new AppError(
        'A batch with this Idempotency-Key is already being processed. Please retry shortly.',
        409,
      );
    }

    if (record.bodyHash !== bodyHash) {
      throw new AppError(
        'Idempotency-Key was already used with a different batch. Use a new key for a new batch.',
        409,
      );
    }

    const state = await store.getBatchState(record.batchId);
    if (state) {
      logger.info('Idempotent batch replay: returning original batch', {
        requestId,
        batchId: record.batchId,
      });
      return {
        replay: true,
        batchId: record.batchId,
        batchStatus: state.status,
        total: state.total,
      };
    }

    // Mapping survived its batch (TTL skew): drop it and start over.
    await store.deleteIdempotencyKey(key);
  }

  throw new AppError(
    'Could not establish idempotent batch submission. Please retry.',
    409,
  );
}

/**
 * GET /api/batches/:batchId
 *
 * Returns current batch status and progress from temporary Redis state.
 * Frontend polls this endpoint to show the progress bar.
 * 404 when the batch is unknown or its TTL has expired.
 */
router.get('/:batchId', pollingLimiter, async (req, res, next) => {
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
router.get('/:batchId/results', pollingLimiter, async (req, res, next) => {
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
