/**
 * API Client
 *
 * Centralizes all backend API calls. The frontend never constructs
 * URLs or fetch options directly — it calls these functions.
 *
 * Single parcel: POST /api/parcels — synchronous 200.
 * Batch: POST /api/batches — async 202, then poll status/results.
 * Batch state and results are temporary Redis state (TTL-expired).
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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
}

/**
 * Sleep that rejects immediately when the signal aborts, so polling loops
 * never sleep past cancellation.
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (err) {
        reject(err);
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * True for user-initiated cancellations (unmount, replaced request).
 * Callers must swallow these silently — they are not application errors.
 */
export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20);
}

/**
 * Routes a single parcel via the backend API (synchronous).
 *
 * @param {object} parcelData - { weight, value, destinationCountry, additionalAttributes }
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Aborts the request (stale UI)
 * @returns {Promise<object>} - The routing result or error object
 */
export async function routeParcel(parcelData, { signal } = {}) {
  const response = await fetch(`${API_BASE}/parcels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parcelData),
    ...(signal ? { signal } : {}),
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
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Aborts the request (stale UI)
 * @param {string} [options.idempotencyKey] - Retried submissions reuse the key
 * @returns {Promise<object>} - { batchId, status, total }
 */
export async function createBatch(parcels, { signal, idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${API_BASE}/batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ parcels }),
    ...(signal ? { signal } : {}),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data.data;
}

/**
 * Polls batch status until terminal state (Master Phase 8: progress via polling).
 * Cancellable: pass an AbortSignal to stop on unmount/replacement — abort
 * rejections must be swallowed by callers, never shown as failures.
 *
 * @param {string} batchId
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Poll interval
 * @param {number} [options.timeoutMs] - Max wait time
 * @param {Function} [options.onProgress] - Called with status payload each poll
 * @param {AbortSignal} [options.signal] - Aborts the loop
 * @returns {Promise<object>} - Final batch status payload
 */
export async function pollBatchStatus(batchId, options = {}) {
  const intervalMs = options.onProgress ? options.intervalMs || 1000 : options.intervalMs || 1000;
  const timeoutMs = options.timeoutMs || 120000;
  const onProgress = options.onProgress || null;
  const signal = options.signal || null;
  const start = Date.now();

  for (;;) {
    throwIfAborted(signal);
    const response = await fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}`, {
      ...(signal ? { signal } : {}),
    });
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
    await abortableSleep(intervalMs, signal);
  }
}

/**
 * Fetches temporary batch results (active processing session, Redis-backed).
 * Results are paginated server-side; the UI loads one page at a time.
 */
export async function fetchBatchResults(batchId, { limit, offset, signal } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/results${qs}`, {
    ...(signal ? { signal } : {}),
  });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw toApiError(data, response);
  }
  return data.data;
}

/**
 * Fetches the list of valid country codes for the dropdown.
 * Full ISO 3166-1 alpha-2 set, served by the backend.
 *
 * @returns {Promise<string[]>} - Sorted array of ISO 3166-1 alpha-2 codes
 */
export async function fetchCountries({ signal } = {}) {
  const response = await fetch(`${API_BASE}/parcels/countries`, {
    ...(signal ? { signal } : {}),
  });
  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(data, response);
  }

  return data.data.countries;
}
