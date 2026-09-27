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

  it('sends a per-submission idempotency key with batch creation', async () => {
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

    // Key present, non-empty, and passed alongside the parcels payload.
    const [, options] = vi.mocked(createBatch).mock.calls[0];
    expect(typeof options.idempotencyKey).toBe('string');
    expect(options.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('processing progress shows a generic title; UUID only as secondary reference', async () => {
    let notifyProgress;
    vi.mocked(createBatch).mockResolvedValue({ batchId: 'BATCH-UUID-1234', status: 'QUEUED' });
    vi.mocked(pollBatchStatus).mockImplementation(
      (_batchId, { onProgress }) =>
        new Promise(() => {
          notifyProgress = onProgress;
        }),
    );
    vi.mocked(fetchBatchResults).mockResolvedValue({ results: [], resultCount: 0 });

    const { container } = render(
      <BatchUpload onBatchResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />,
    );
    uploadParcels(container);
    fireEvent.click(await screen.findByRole('button', { name: /Process 1 Parcel/ }));
    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));

    notifyProgress({
      batchId: 'BATCH-UUID-1234',
      status: 'PROCESSING',
      processed: 123,
      total: 500,
      progress: 25,
    });
    expect(await screen.findByText('Batch Processing')).toBeTruthy();
    expect(screen.getByText(/Status:/)).toBeTruthy();
    // Raw UUID is secondary metadata only — never the primary title.
    const reference = container.querySelector('.batch-reference');
    expect(reference).toBeTruthy();
    expect(reference.textContent).toContain('BATCH-UUID-1234');
    const progressText = container.querySelector('.batch-progress').textContent;
    expect(progressText).not.toMatch(/^Batch BATCH-/);
    expect(progressText).toContain('123 / 500');
  });

  it('advertises the 9 MB client ceiling (below the 10 MB server limit)', async () => {
    render(<BatchUpload onBatchResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText(/Supports \.json files up to 9 MB/)).toBeTruthy();
  });

  it('rejects an oversized file early with a clear message', async () => {
    const { container } = render(
      <BatchUpload onBatchResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />,
    );
    const big = new File([new Uint8Array(9 * 1024 * 1024 + 1024)], 'big.json', {
      type: 'application/json',
    });
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [big] },
    });
    expect(await screen.findByText(/File is too large/)).toBeTruthy();
    expect(screen.getByText(/Maximum size is 9 MB/)).toBeTruthy();
    expect(createBatch).not.toHaveBeenCalled();
  });
});

describe('BatchUpload FileReader lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    vi.mocked(createBatch).mockReset();
    vi.mocked(pollBatchStatus).mockReset();
    vi.mocked(fetchBatchResults).mockReset();
  });

  function installFakeReader() {
    const instances = [];
    class FakeReader {
      constructor() {
        instances.push(this);
        this.aborted = false;
        this.onload = null;
        this.onerror = null;
        this.onabort = null;
        this.error = null;
      }
      readAsText(file) {
        this.file = file;
      }
      abort() {
        this.aborted = true;
        if (this.onabort) this.onabort();
      }
      complete(text) {
        if (this.aborted) return;
        if (this.onload) this.onload({ target: { result: text } });
      }
    }
    vi.stubGlobal('FileReader', FakeReader);
    return instances;
  }

  function selectFile(container, file) {
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [file] },
    });
  }

  it('aborts the previous reader when a new file is selected; only the latest applies', async () => {
    const instances = installFakeReader();
    const { container } = render(
      <BatchUpload onBatchResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />,
    );

    selectFile(container, new File(['[invalid json'], 'a.json', { type: 'application/json' }));
    selectFile(
      container,
      new File([JSON.stringify({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] })], 'b.json', {
        type: 'application/json',
      }),
    );

    expect(instances).toHaveLength(2);
    expect(instances[0].aborted).toBe(true);

    // Late completion from the superseded reader is ignored.
    instances[0].complete(JSON.stringify({ parcels: [{ weight: 9, value: 9, destinationCountry: 'FR' }] }));
    // Current reader completes: exactly one parcel detected.
    instances[1].complete(JSON.stringify({ parcels: [{ weight: 1, value: 10, destinationCountry: 'DE' }] }));

    expect(await screen.findByRole('button', { name: /Process 1 Parcel/ })).toBeTruthy();
  });

  it('unmount during a read never surfaces an error', async () => {
    const instances = installFakeReader();
    const onError = vi.fn();
    const { container, unmount } = render(
      <BatchUpload onBatchResult={vi.fn()} onError={onError} onClear={vi.fn()} />,
    );

    selectFile(container, new File(['pending'], 'a.json', { type: 'application/json' }));
    expect(instances).toHaveLength(1);
    unmount();
    expect(instances[0].aborted).toBe(true);

    // Late callbacks after unmount are silent.
    instances[0].complete(JSON.stringify({ parcels: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).not.toHaveBeenCalled();
  });
});
