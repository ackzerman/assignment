// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createBatch, pollBatchStatus, fetchBatchResults } from './api.js';
import BatchUpload from './components/BatchUpload.jsx';

vi.mock('./api.js', () => ({
  createBatch: vi.fn(),
  pollBatchStatus: vi.fn(),
  fetchBatchResults: vi.fn(),
}));

function uploadParcels(container) {
  const file = new File(
    [JSON.stringify({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] })],
    'batch.json',
    { type: 'application/json' },
  );
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });
}

describe('BatchUpload duplicate submission guard', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.mocked(createBatch).mockReset();
    vi.mocked(pollBatchStatus).mockReset();
    vi.mocked(fetchBatchResults).mockReset();
  });

  it('two concurrent process actions result in a single createBatch() call', async () => {
    let resolveCreate;
    vi.mocked(createBatch).mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'COMPLETED' });
    vi.mocked(fetchBatchResults).mockResolvedValue({ results: [], resultCount: 0 });

    const onBatchResult = vi.fn();
    const { container } = render(
      <BatchUpload onBatchResult={onBatchResult} onError={vi.fn()} onClear={vi.fn()} />,
    );
    uploadParcels(container);
    const processButton = await screen.findByRole('button', { name: /Process 1 Parcel/ });
    expect(processButton.disabled).toBe(false);

    // Two synchronous invocations before React can re-render/disabled state:
    // the ref guard must let exactly one through.
    fireEvent.click(processButton);
    fireEvent.click(processButton);
    expect(createBatch).toHaveBeenCalledTimes(1);

    // Finish the flow; the result is delivered exactly once.
    resolveCreate({ batchId: 'BATCH-1', status: 'QUEUED' });
    await waitFor(() => expect(onBatchResult).toHaveBeenCalledTimes(1));
    expect(createBatch).toHaveBeenCalledTimes(1);
  });

  it('a later submission works after reset clears the guard', async () => {
    vi.mocked(createBatch).mockResolvedValue({ batchId: 'BATCH-1', status: 'QUEUED' });
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'COMPLETED' });
    vi.mocked(fetchBatchResults).mockResolvedValue({ results: [], resultCount: 0 });

    const { container } = render(
      <BatchUpload onBatchResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />,
    );
    uploadParcels(container);
    const processButton = await screen.findByRole('button', { name: /Process 1 Parcel/ });
    fireEvent.click(processButton);
    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    uploadParcels(container);
    const processAgain = await screen.findByRole('button', { name: /Process 1 Parcel/ });
    fireEvent.click(processAgain);
    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(2));
  });
});
