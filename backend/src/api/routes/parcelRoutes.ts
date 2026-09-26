/**
 * Parcel API Routes
 *
 * These routes are a thin HTTP layer. They:
 * 1. Extract data from the request
 * 2. Call domain logic (validation)
 * 3. Return the result
 *
 * No business logic lives here (Rule 5).
 * The routing engine will be added in Phase 2.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { validateParcelInput } from '../../domain/validation';
import { getValidCountryCodes } from '../../domain/validation';
import { ValidationFailedError } from '../../errors/AppError';
import { ParcelInput } from '../../domain/parcel';

const router = Router();

/**
 * POST /api/parcels/validate
 *
 * Validates a single parcel input.
 * Returns the validated parcel or validation errors.
 *
 * In Phase 2, this will be extended to also route the parcel.
 */
router.post(
  '/validate',
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const input: ParcelInput = req.body;

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
  }
);

/**
 * GET /api/parcels/countries
 *
 * Returns the list of valid country codes.
 * Used by the frontend to populate the country dropdown.
 */
router.get(
  '/countries',
  (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'success',
      data: {
        countries: getValidCountryCodes(),
      },
    });
  }
);

export default router;
