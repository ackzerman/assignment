/**
 * API Client
 *
 * Centralizes all backend API calls. The frontend never constructs
 * URLs or fetch options directly — it calls these functions.
 *
 * Why a separate file?
 * - Single place to change if the API base URL or headers change
 * - Consistent error handling for network vs validation errors
 * - Easy to mock in future frontend tests
 */

const API_BASE = '/api';

/**
 * Routes a single parcel via the backend API.
 *
 * @param {object} parcelData - { weight, value, destinationCountry, additionalAttributes }
 * @returns {Promise<object>} - The routing result or error object
 */
export async function routeParcel(parcelData) {
  const response = await fetch(`${API_BASE}/parcels/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parcelData),
  });

  const data = await response.json();

  if (!response.ok) {
    // Backend returns { status: 'error', message, errors? }
    const error = new Error(data.message || 'Request failed');
    error.status = response.status;
    error.validationErrors = data.errors || null;
    throw error;
  }

  return data;
}

/**
 * Processes a batch of parcels via the backend API.
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

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.message || 'Batch processing failed');
    error.status = response.status;
    throw error;
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
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Failed to fetch countries');
  }

  return data.data.countries;
}
