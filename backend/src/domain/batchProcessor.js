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

  // Duplicate parcel IDs would create ambiguous results for the same
  // parcelId within one batch. Reject them up front instead.
  // Only explicitly provided IDs are checked; parcels without an ID receive
  // an auto-generated one later and are unaffected.
  const seenIds = new Set();
  for (let i = 0; i < data.parcels.length; i++) {
    const parcel = data.parcels[i];
    if (parcel && typeof parcel === 'object' && parcel.parcelId !== undefined && parcel.parcelId !== null && parcel.parcelId !== '') {
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

module.exports = {
  validateBatchInput,
  DEFAULT_MAX_BATCH_SIZE,
};
