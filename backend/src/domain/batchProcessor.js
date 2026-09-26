/**
 * Batch Processor
 *
 * Processes an array of parcel data in chunks, validating and routing each
 * parcel independently. This ensures:
 *
 * 1. MIXED-VALIDITY — One invalid parcel doesn't block the rest.
 *    Valid parcels are routed, invalid ones are reported with errors.
 *
 * 2. CHUNKED PROCESSING — Large arrays are processed in configurable chunks
 *    to avoid blocking the event loop and consuming excessive memory.
 *    This is important because a batch could contain 100,000+ parcels.
 *
 * 3. PROGRESS REPORTING — An optional callback receives progress updates
 *    after each chunk, enabling real-time progress in the UI.
 *
 * Design Decision: Why process in the same request rather than a job queue?
 * - A job queue (Bull, Bee-Queue) would be overkill for this assessment
 * - The assessment says "do not build a distributed job-processing platform"
 * - Chunked synchronous processing with progress callbacks is the right
 *   balance of simplicity and large-file handling
 */

const { validateParcelInput } = require('./validation');
const { routeParcel } = require('./routingEngine');

// Default chunk size — how many parcels to process before yielding
const DEFAULT_CHUNK_SIZE = 100;

/**
 * Processes a batch of parcels, validating and routing each one.
 *
 * @param {Array} parcels - Array of raw parcel data objects
 * @param {object} [options] - Processing options
 * @param {number} [options.chunkSize] - Number of parcels per chunk (default: 100)
 * @param {Function} [options.onProgress] - Called after each chunk with { processed, total, successful, failed }
 * @returns {object} Batch result with summary and individual results
 */
async function processBatch(parcels, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const onProgress = options.onProgress || null;

  const results = [];
  let successful = 0;
  let failed = 0;

  // Process in chunks to avoid blocking the event loop
  for (let i = 0; i < parcels.length; i += chunkSize) {
    const chunk = parcels.slice(i, i + chunkSize);

    for (let j = 0; j < chunk.length; j++) {
      const index = i + j;
      const parcelData = chunk[j];

      try {
        const result = processOneParcel(parcelData, index);
        results.push(result);

        if (result.status === 'routed') {
          successful++;
        } else {
          failed++;
        }
      } catch (err) {
        // Unexpected error — still don't crash the batch
        results.push({
          index,
          status: 'error',
          errors: [{ field: '_system', message: `Unexpected error: ${err.message}` }],
          input: sanitizeInput(parcelData),
        });
        failed++;
      }
    }

    // Report progress after each chunk
    if (onProgress) {
      onProgress({
        processed: Math.min(i + chunkSize, parcels.length),
        total: parcels.length,
        successful,
        failed,
      });
    }

    // Yield to the event loop between chunks so we don't block other requests.
    // This is the lightweight alternative to worker threads or streams.
    if (i + chunkSize < parcels.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    summary: {
      total: parcels.length,
      successful,
      failed,
      processedAt: new Date().toISOString(),
    },
    results,
  };
}

/**
 * Processes a single parcel within a batch — validates then routes.
 *
 * @param {object} parcelData - Raw parcel data
 * @param {number} index - Index in the batch (for error reporting)
 * @returns {object} Result for this parcel
 */
function processOneParcel(parcelData, index) {
  // Step 1: Validate
  const validation = validateParcelInput(parcelData);

  if (!validation.success) {
    return {
      index,
      status: 'invalid',
      errors: validation.errors,
      input: sanitizeInput(parcelData),
    };
  }

  // Step 2: Route
  const routing = routeParcel(validation.parcel);

  return {
    index,
    status: 'routed',
    department: routing.department,
    departmentReason: routing.departmentReason,
    requiresApproval: routing.requiresApproval,
    approvals: routing.approvals,
    parcel: routing.parcel,
  };
}

/**
 * Sanitizes input for inclusion in error responses.
 * Prevents huge or malicious data from bloating the response.
 */
function sanitizeInput(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return { raw: String(input).substring(0, 200) };

  return {
    weight: input.weight,
    value: input.value,
    destinationCountry: input.destinationCountry,
  };
}

/**
 * Validates the batch container itself (not individual parcels).
 *
 * @param {*} data - The parsed request body
 * @param {number} maxBatchSize - Maximum allowed parcels in one batch
 * @returns {{ valid: true, parcels: Array } | { valid: false, error: string }}
 */
function validateBatchInput(data, maxBatchSize = 10000) {
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

  return { valid: true, parcels: data.parcels };
}

module.exports = {
  processBatch,
  processOneParcel,
  validateBatchInput,
  DEFAULT_CHUNK_SIZE,
};
