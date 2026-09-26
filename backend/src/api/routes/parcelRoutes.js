/**
 * Parcel API Routes
 *
 * These routes are a thin HTTP layer. They:
 * 1. Extract data from the request
 * 2. Call domain logic (validation + routing)
 * 3. Return the result
 *
 * No business logic lives here (Rule 5).
 */

const express = require('express');
const { validateParcelInput, getValidCountryCodes } = require('../../domain/validation');
const { routeParcel } = require('../../domain/routingEngine');
const { processBatch, validateBatchInput } = require('../../domain/batchProcessor');
const { ValidationFailedError, AppError } = require('../../errors/AppError');

const router = express.Router();

/**
 * POST /api/parcels/route
 *
 * Validates and routes a single parcel.
 * Returns the routing result with department, reason, and approvals.
 */
router.post('/route', (req, res, next) => {
  try {
    const input = req.body;

    // Step 1: Validate
    const validation = validateParcelInput(input);
    if (!validation.success) {
      throw new ValidationFailedError(validation.errors);
    }

    // Step 2: Route
    const result = routeParcel(validation.parcel);

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
 * Useful for checking input before submitting.
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
 * Used by the frontend to populate the country dropdown.
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
 *
 * Expected body: { "parcels": [ { weight, value, destinationCountry, ... }, ... ] }
 *
 * Each parcel is validated and routed independently.
 * Invalid parcels are reported with errors but don't block valid ones.
 *
 * Returns:
 * {
 *   summary: { total, successful, failed, processedAt },
 *   results: [ { index, status, department?, errors?, ... }, ... ]
 * }
 */
router.post('/batch', async (req, res, next) => {
  try {
    // Step 1: Validate the batch container
    const batchValidation = validateBatchInput(req.body);
    if (!batchValidation.valid) {
      throw new AppError(batchValidation.error, 400);
    }

    // Step 2: Process each parcel (validate + route)
    const result = await processBatch(batchValidation.parcels);

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

