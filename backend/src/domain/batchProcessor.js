/**
 * Batch Input Validation (domain helper)
 *
 * Pure, dependency-free validation of the batch envelope. Batch PROCESSING
 * itself is asynchronous: POST /api/batches → Redis state → BullMQ → worker.
 * There is exactly one runtime batch implementation (the worker).
 */

const DEFAULT_MAX_BATCH_SIZE = 10000;

/**
 * Validates the batch container itself (not individual parcels).
 *
 * @param {*} data - The parsed request body
 * @param {number} maxBatchSize - Maximum allowed parcels in one batch
 * @returns {{ valid: true, parcels: Array } | { valid: false, error: string }}
 */
function validateBatchInput(data, maxBatchSize = DEFAULT_MAX_BATCH_SIZE) {
  if (!data || !data.parcels) {
    return {
      valid: false,
      error: 'Request body must contain a "parcels" array. Example: { "parcels": [{ "weight": 2, "value": 100, "destinationCountry": "DE" }] }',
    };
  }

  if (!Array.isArray(data.parcels)) {
    return {
      valid: false,
      error: '"parcels" must be an array.',
    };
  }

  if (data.parcels.length === 0) {
    return {
      valid: false,
      error: 'Batch must contain at least one parcel.',
    };
  }

  if (data.parcels.length > maxBatchSize) {
    return {
      valid: false,
      error: `Batch size exceeds maximum of ${maxBatchSize.toLocaleString()} parcels. Please split into smaller batches.`,
    };
  }

  // Duplicate EXPLICIT parcel IDs are rejected here. Generated IDs are
  // assigned afterwards (see assignParcelIds) and the FINAL uniqueness of
  // every parcelId is enforced then — so a generated P{N} can never silently
  // collide with an explicit "P{N}".
  const seenIds = new Set();
  for (let i = 0; i < data.parcels.length; i++) {
    const parcel = data.parcels[i];
    if (parcel && typeof parcel === 'object' && hasParcelId(parcel.parcelId)) {
      const typeError = validateParcelId(parcel.parcelId);
      if (typeError) {
        return {
          valid: false,
          error: `Invalid parcelId at index ${i}. ${typeError}`,
        };
      }
      const key = String(parcel.parcelId);
      if (seenIds.has(key)) {
        return {
          valid: false,
          error: `Duplicate parcelId "${parcel.parcelId}" in batch (index ${i}). Parcel IDs must be unique within a batch.`,
        };
      }
      seenIds.add(key);
    }
  }

  return { valid: true, parcels: data.parcels };
}

/**
 * Parcel ID contract (shared by single-parcel and batch paths):
 *
 * - parcelId is OPTIONAL. Missing means undefined, null, or ''.
 * - Presence is NEVER decided by truthiness: valid IDs like 0 are kept.
 * - When present, a parcelId must be a string or a finite number.
 *   Objects, arrays, booleans, NaN and Infinity are rejected.
 */

/**
 * Presence check that does not confuse falsy-but-valid IDs (e.g. 0).
 */
function hasParcelId(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Validates a present parcelId's type/format.
 * @returns {string|null} Error message, or null when valid/missing.
 */
function validateParcelId(value) {
  if (!hasParcelId(value)) return null;
  if (typeof value === 'string') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  return 'parcelId must be a string or a finite number.';
}
/**
 * Assigns fallback parcel IDs (`P{index+1}`) to parcels that do not provide
 * one. Presence uses hasParcelId (not truthiness), so valid falsy IDs like
 * 0 are preserved. Pure function — returns a new array, never mutates input.
 */
function assignParcelIds(parcels) {
  return parcels.map((p, i) => {
    if (p && typeof p === 'object' && !hasParcelId(p.parcelId)) {
      return { ...p, parcelId: `P${i + 1}` };
    }
    return p;
  });
}

/**
 * Enforces the final invariant: every parcel in the batch has a unique
 * parcelId (explicit or generated). Returns an error string, or null.
 */
function findDuplicateParcelId(parcels) {
  const seen = new Set();
  for (let i = 0; i < parcels.length; i++) {
    const parcel = parcels[i];
    const id = parcel && typeof parcel === 'object' ? parcel.parcelId : undefined;
    if (!hasParcelId(id)) continue;
    const key = String(id);
    if (seen.has(key)) {
      return `Duplicate parcelId "${id}" in batch (index ${i}). Parcel IDs must be unique within a batch.`;
    }
    seen.add(key);
  }
  return null;
}

module.exports = {
  validateBatchInput,
  assignParcelIds,
  findDuplicateParcelId,
  hasParcelId,
  validateParcelId,
  DEFAULT_MAX_BATCH_SIZE,
};
