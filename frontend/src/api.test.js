import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatch, pollBatchStatus, fetchBatchResults } from './api.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('createBatch posts parcels and returns the accepted payload', async () => {
    fetch.mockResolvedValue(jsonResponse({ status: 'accepted', data: { batchId: 'B1', status: 'QUEUED' } }));
    const created = await createBatch([{ weight: 1 }]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/batches',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(created).toEqual({ batchId: 'B1', status: 'QUEUED' });
  });

  it('pollBatchStatus resolves on terminal status and reports progress', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'PROCESSING', progress: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'COMPLETED', progress: 100 } }));
    const seen = [];
    const final = await pollBatchStatus('B1', { intervalMs: 1, onProgress: (b) => seen.push(b.status) });
    expect(final.status).toBe('COMPLETED');
    expect(seen).toEqual(['PROCESSING', 'COMPLETED']);
  });

  it('pollBatchStatus times out instead of hanging forever', async () => {
    fetch.mockResolvedValue(jsonResponse({ data: { status: 'PROCESSING' } }));
    await expect(pollBatchStatus('B1', { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
  });

  it('fetchBatchResults sends limit/offset for paging through large sets', async () => {
    fetch.mockResolvedValue(jsonResponse({ data: { results: [], resultCount: 10000 } }));
    await fetchBatchResults('B1', { limit: 200, offset: 400 });
    const url = fetch.mock.calls[0][0];
    expect(url).toContain('limit=200');
    expect(url).toContain('offset=400');
  });

  it('maps API errors with validation details', async () => {
    fetch.mockResolvedValue(jsonResponse(
      { message: 'Validation failed', errors: [{ field: 'weight' }] },
      { ok: false, status: 400 },
    ));
    await expect(createBatch([])).rejects.toMatchObject({ status: 400, validationErrors: [{ field: 'weight' }] });
  });

  it('createBatch forwards the idempotency key header when provided', async () => {
    fetch.mockResolvedValue(jsonResponse({ status: 'accepted', data: { batchId: 'B1', status: 'QUEUED' } }));
    await createBatch([{ weight: 1 }], { idempotencyKey: 'key-123' });
    const [, options] = fetch.mock.calls[0];
    expect(options.headers['Idempotency-Key']).toBe('key-123');
  });

  it('createBatch omits the idempotency header when no key is given', async () => {
    fetch.mockResolvedValue(jsonResponse({ status: 'accepted', data: { batchId: 'B1', status: 'QUEUED' } }));
    await createBatch([{ weight: 1 }]);
    const [, options] = fetch.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('pollBatchStatus aborts cleanly on signal without further requests', async () => {
    fetch.mockResolvedValue(jsonResponse({ data: { status: 'PROCESSING', progress: 10 } }));
    const controller = new AbortController();
    const pending = pollBatchStatus('B1', { intervalMs: 5, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const callsAfterAbort = fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetch.mock.calls.length).toBe(callsAfterAbort);
  });
});
