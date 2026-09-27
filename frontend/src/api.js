/**
 * API Client
 *
 * Centralizes all backend API calls. The frontend never constructs
 * URLs or fetch options directly — it calls these functions.
 *
 * Single parcel: POST /api/parcels (canonical, Master Phase 3) — synchronous 200.
 * Batch: POST /api/batches (Master Phase 4) — async 202, then poll status/results.
 * Legacy aliases (/api/parcels/route, /api/parcels/batch) are still supported
 * by the backend for backward compatibility.
 */

const API_BASE = '/api';

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function toApiError(data, response) {
  const error = new Error(data.message || 'Request failed');
  error.status = response.status;
  error.validationErrors = data.errors || null;
  return error;
}

/**
 * Routes a single parcel via the backend API (synchronous).
 *
 * @param {object} parcelData - { weight, value, destinationCountry, additionalAttributes }
 * @returns {Promise<object>} - The routing result or error object
 */
export async function routeParcel(parcelData) {
  const response = await fetch(`${API_BASE}/parcels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parcelData),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data;
}

/**
 * Creates an async batch (Master Phase 4).
 * Returns 202 with { batchId, status } — processing continues in the worker.
 *
 * @param {Array} parcels - Array of parcel data objects
 * @returns {Promise<object>} - { batchId, status, total }
 */
export async function createBatch(parcels) {
  const response = await fetch(`${API_BASE}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parcels }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data.data;
}

/**
 * Polls batch status until terminal state (Master Phase 8: progress via polling).
 *
 * @param {string} batchId
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Poll interval
 * @param {number} [options.timeoutMs] - Max wait time
 * @param {Function} [options.onProgress] - Called with status payload each poll
 * @returns {Promise<object>} - Final batch status payload
 */
export async function pollBatchStatus(batchId, options = {}) {
  const intervalMs = options.onProgress ? options.intervalMs || 1000 : options.intervalMs || 1000;
  const timeoutMs = options.timeoutMs || 120000;
  const onProgress = options.onProgress || null;
  const start = Date.now();

  for (;;) {
    const response = await fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}`);
    const data = await parseJsonSafe(response);
    if (!response.ok) {
      throw toApiError(data, response);
    }
    const batch = data.data;
    if (onProgress) {
      onProgress(batch);
    }
    if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(batch.status)) {
      return batch;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for batch ${batchId} (last status: ${batch.status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Fetches persisted batch results (Master: DB is source of truth).
 */
export async function fetchBatchResults(batchId, { limit, offset } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/results${qs}`);
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw toApiError(data, response);
  }
  return data.data;
}

/**
 * Legacy synchronous batch (kept for backward compatibility).
 * Prefer createBatch + pollBatchStatus for new code.
 *
 * @param {Array} parcels - Array of parcel data objects
 * @returns {Promise<object>} - Batch result with summary and individual results
 */
export async function routeBatch(parcels) {
  const response = await fetch(`${API_BASE}/parcels/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parcels }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data;
}

/**
 * Fetches the list of valid country codes for the dropdown.
 *
 * @returns {Promise<string[]>} - Sorted array of ISO 3166-1 alpha-2 codes
 */
export async function fetchCountries() {
  const response = await fetch(`${API_BASE}/parcels/countries`);
  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data.data.countries;
}
