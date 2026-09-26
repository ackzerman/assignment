/**
 * Parcel API Routes
 *
 * These routes are a thin HTTP layer. They:
 * 1. Extract data from the request
 * 2. Call domain logic (validation + routing)
 * 3. Record metrics and log outcomes
 * 4. Return the result
 *
 * No business logic lives here.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { validateParcelInput, getValidCountryCodes } = require('../../domain/validation');
const { routeParcel } = require('../../domain/routingEngine');
const { processBatch, validateBatchInput } = require('../../domain/batchProcessor');
const { ValidationFailedError, AppError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { recordRouting, recordFailure, recordBatch, recordProcessingTime } = require('../../observability/metrics');

const router = express.Router();

/**
 * POST /api/parcels/route
 *
 * Validates and routes a single parcel.
 */
router.post('/route', (req, res, next) => {
  const start = Date.now();

  try {
    const input = req.body;

    // Step 1: Validate
    const validation = validateParcelInput(input);
    if (!validation.success) {
      recordFailure();
      logger.info('Parcel validation failed', {
        requestId: req.id,
        operation: 'route_parcel',
        errors: validation.errors.length,
      });
      throw new ValidationFailedError(validation.errors);
    }

    // Step 2: Route
    const result = routeParcel(validation.parcel);

    // Step 3: Record metrics
    recordRouting(result.department, result.approvals);
    recordProcessingTime(Date.now() - start);

    logger.info('Parcel routed', {
      requestId: req.id,
      operation: 'route_parcel',
      department: result.department,
      requiresApproval: result.requiresApproval,
      rule: result.departmentRule,
      durationMs: Date.now() - start,
    });

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/parcels/validate
 *
 * Validates a single parcel input without routing.
 */
router.post('/validate', (req, res, next) => {
  try {
    const input = req.body;
    const result = validateParcelInput(input);

    if (!result.success) {
      throw new ValidationFailedError(result.errors);
    }

    res.status(200).json({
      status: 'success',
      message: 'Parcel validated successfully.',
      data: {
        parcel: result.parcel,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/parcels/countries
 *
 * Returns the list of valid country codes.
 */
router.get('/countries', (_req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      countries: getValidCountryCodes(),
    },
  });
});

/**
 * POST /api/parcels/batch
 *
 * Processes a batch of parcels from a JSON upload.
 * Assigns a unique batch ID for tracking.
 *
 * User-facing response:
 *   "980 parcels processed successfully. 20 parcels require correction. Batch ID: BATCH-abc123"
 *
 * Internal logs:
 *   Detailed per-parcel routing decisions, timing, errors with full context.
 */
router.post('/batch', async (req, res, next) => {
  const start = Date.now();
  const batchId = `BATCH-${randomUUID().split('-')[0]}`;

  try {
    // Step 1: Validate the batch container
    const batchValidation = validateBatchInput(req.body);
    if (!batchValidation.valid) {
      logger.warn('Batch validation failed', {
        requestId: req.id,
        batchId,
        operation: 'batch_process',
        error: batchValidation.error,
      });
      throw new AppError(batchValidation.error, 400);
    }

    logger.info('Batch processing started', {
      requestId: req.id,
      batchId,
      operation: 'batch_process',
      parcelCount: batchValidation.parcels.length,
    });

    // Step 2: Process each parcel (validate + route)
    const result = await processBatch(batchValidation.parcels);

    // Step 3: Record metrics
    const duration = Date.now() - start;
    recordBatch(result.summary);
    recordProcessingTime(duration);

    // Record individual routing outcomes for metrics
    for (const r of result.results) {
      if (r.status === 'routed') {
        recordRouting(r.department, r.approvals || []);
      } else {
        recordFailure();
      }
    }

    logger.info('Batch processing completed', {
      requestId: req.id,
      batchId,
      operation: 'batch_process',
      total: result.summary.total,
      successful: result.summary.successful,
      failed: result.summary.failed,
      durationMs: duration,
    });

    // Add batch ID to the response for operator tracking
    res.status(200).json({
      status: 'success',
      data: {
        batchId,
        ...result,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
