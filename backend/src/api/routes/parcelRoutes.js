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
const { hasParcelId, validateParcelId } = require('../../domain/batchProcessor');
const { routeParcel } = require('../../domain/routingEngine');
const { ValidationFailedError } = require('../../errors/AppError');
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

    // Step 1: Validate (parcel fields + parcelId type, shared contract)
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
    const parcelIdTypeError = validateParcelId(input.parcelId);
    if (parcelIdTypeError) {
      recordFailure();
      throw new ValidationFailedError([{ field: 'parcelId', message: parcelIdTypeError }]);
    }

    // Step 2: Route (shared domain core)
    const result = routeParcel(validation.parcel);

    // Step 3: Record metrics
    recordRouting(result.department, result.approvals);
    recordProcessingTime(Date.now() - start);

    const parcelId = hasParcelId(input.parcelId) ? input.parcelId : `P-${randomUUID().split('-')[0]}`;

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

    const parcelIdTypeError = validateParcelId(input.parcelId);
    if (parcelIdTypeError) {
      throw new ValidationFailedError([{ field: 'parcelId', message: parcelIdTypeError }]);
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

module.exports = router;
