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
const { validateBatchInput } = require('../../domain/batchProcessor');
const { enqueueBatch } = require('./batchRoutes');
const { authOptional } = require('../middleware/auth');
const { ValidationFailedError, AppError } = require('../../errors/AppError');
const { logger } = require('../../observability/logger');
const { recordRouting, recordFailure, recordProcessingTime } = require('../../observability/metrics');

const router = express.Router();

/**
 * Shared single-parcel handler (synchronous, per Master Phase 3).
 * Used by both POST /api/parcels (canonical) and POST /api/parcels/route (legacy alias).
 * Returns the master-prompt explainable shape alongside legacy detail fields.
 */
function handleSingleParcel(req, res, next) {
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

    // Step 2: Route (shared domain core)
    const result = routeParcel(validation.parcel);

    // Step 3: Record metrics
    recordRouting(result.department, result.approvals);
    recordProcessingTime(Date.now() - start);

    const parcelId = input.parcelId || `P-${randomUUID().split('-')[0]}`;

    logger.info('Parcel routed', {
      requestId: req.id,
      operation: 'route_parcel',
      parcelId,
      department: result.department,
      requiresApproval: result.requiresApproval,
      rule: result.departmentRule,
      durationMs: Date.now() - start,
    });

    res.status(200).json({
      status: 'success',
      data: {
        // Master-prompt canonical explainable contract
        parcelId,
        department: result.department,
        approvals: result.approvals.map((a) => a.type),
        matchedRules: result.matchedRules,
        reasons: result.reasons,
        // Legacy detail fields (backward compatible)
        departmentReason: result.departmentReason,
        departmentRule: result.departmentRule,
        requiresApproval: result.requiresApproval,
        approvalsDetail: result.approvals,
        parcel: result.parcel,
        routedAt: result.routedAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/parcels — canonical single-parcel endpoint (Master Phase 3).
 * Synchronous, returns 200 OK with the routing result.
 */
router.post('/', handleSingleParcel);

/**
 * POST /api/parcels/route — legacy alias, kept for backward compatibility.
 *
 * Validates and routes a single parcel.
 */
router.post('/route', handleSingleParcel);

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
 * POST /api/parcels/batch — LEGACY compatibility alias (async).
 *
 * Historically this endpoint processed batches synchronously in the request.
 * It now reuses the canonical asynchronous creation path (same validation,
 * same DB record, same BullMQ job as POST /api/batches) so only ONE batch
 * implementation exists. Returns 202; poll GET /api/batches/:batchId.
 */
router.post('/batch', authOptional, async (req, res, next) => {
  try {
    const batchValidation = validateBatchInput(req.body);
    if (!batchValidation.valid) {
      logger.warn('Batch validation failed', {
        requestId: req.id,
        operation: 'batch_process_legacy',
        error: batchValidation.error,
      });
      throw new AppError(batchValidation.error, 400);
    }

    const owner = req.user?.id || 'anonymous';
    const created = await enqueueBatch(batchValidation.parcels, {
      owner,
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

module.exports = router;
