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

/**
 * Assigns fallback parcel IDs (`P{index+1}`) to parcels that do not provide
 * one. Pure function — returns a new array, never mutates the input.
 */
function assignParcelIds(parcels) {
  return parcels.map((p, i) => {
    if (p && typeof p === 'object' && (p.parcelId === undefined || p.parcelId === null || p.parcelId === '')) {
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
    if (id === undefined || id === null || id === '') continue;
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
  DEFAULT_MAX_BATCH_SIZE,
};
