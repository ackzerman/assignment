import { useState, useRef, useEffect } from 'react';
import { createBatch, pollBatchStatus, fetchBatchResults, isAbortError } from '../api';

/**
 * BatchUpload — File upload component for batch parcel processing.
 *
 * Design Decisions:
 *
 * 1. JSON FORMAT — We chose JSON over XML because:
 *    - Native to JavaScript — no parser libraries needed
 *    - Simpler syntax for operators to create/edit
 *    - Matches the existing single-parcel API format
 *    - Smaller file sizes than equivalent XML
 *    (See ENGINEERING_DECISIONS.md for full comparison)
 *
 * 2. DRAG-AND-DROP + FILE INPUT — Both options for operator convenience.
 *    Drag-and-drop is faster for repeated use, file input works everywhere.
 *
 * 3. FILE PREVIEW — Show the number of parcels detected before processing.
 *    This gives operators a chance to verify they selected the right file.
 *
 * 4. CLIENT-SIDE PARSING — Parse JSON in the browser before sending.
 *    This gives immediate feedback on malformed files without a round trip.
 *    The actual validation of each parcel still happens server-side.
 */

// Maximum upload file size: 9 MB — deliberately BELOW the backend's ~10 MB
// JSON body limit. The file is wrapped in {"parcels": [...]} before sending,
// so a file at exactly 10 MB would always exceed the server limit and 413.
// The 1 MB margin absorbs envelope overhead; the backend remains
// authoritative and still 413s anything over its own limit.
const MAX_FILE_SIZE = 9 * 1024 * 1024;
const MAX_FILE_SIZE_MB = 9;

export default function BatchUpload({ onBatchResult, onError, onClear }) {
  const [file, setFile] = useState(null);
  const [parcels, setParcels] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  // Synchronous submit guard: React state updates are async, so two rapid
  // handleProcess() invocations could both pass a `processing` check before
  // either re-renders. A ref flips synchronously, guaranteeing a single
  // in-flight POST /api/batches per user action.
  const submittingRef = useRef(false);
  // AbortController for the in-flight submission+poll: aborted on unmount so
  // background polling can never update a dead component or a replaced batch.
  // Aborts are silent — they are user navigation, not application errors.
  const abortRef = useRef(null);
  // Active FileReader: aborted on unmount or when a newer file supersedes it,
  // so stale read callbacks can never mutate current component state.
  const readerRef = useRef(null);
  // Monotonic generation: every handleFile bumps it; reader callbacks check
  // their generation and no-op when stale (replaced file or unmount).
  const fileGenRef = useRef(0);

  // Abort any in-flight batch flow AND file read when this component unmounts
  // (tab switch / navigation). Prevents leaked polling, leaked reads, and
  // stale UI updates. No setState here — the component is gone.
  useEffect(() => () => {
    fileGenRef.current++;
    readerRef.current?.abort();
    readerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * Cancels the in-flight batch submission/poll without touching file state.
   * Used when a newer file supersedes the run or the operator resets: the
   * late poll callbacks abort silently (never overwrite the new UI), and the
   * submit guard is released so the new file can be processed.
   */
  function abortBatchFlow() {
    abortRef.current?.abort();
    abortRef.current = null;
    submittingRef.current = false;
    setProcessing(false);
    setProgress(null);
  }

  function resetFileInput() {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  /**
   * Reads and parses a JSON file.
   * Validates structure before sending to the backend.
   */
  function handleFile(selectedFile) {
    // A newer file supersedes everything in flight: abort the pending read
    // (invalidating its callbacks) AND any running batch poll, so stale work
    // can never overwrite the UI for this file.
    fileGenRef.current++;
    readerRef.current?.abort();
    readerRef.current = null;
    abortBatchFlow();

    // Reset file state (but NOT the parent result: picking a file — even an
    // invalid one — must not wipe a previously good result; onClear runs
    // only once the new file parses successfully).
    setParseError(null);
    setParcels(null);
    setFile(null);

    // Validate file type (case-insensitive: some systems save FILE.JSON)
    if (!selectedFile.name.toLowerCase().endsWith('.json')) {
      setParseError('Please upload a JSON file (.json).');
      resetFileInput();
      return;
    }

    // Validate file size (client ceiling sits below the server body limit
    // so predictable 413s are rejected early with a clear message).
    if (selectedFile.size > MAX_FILE_SIZE) {
      setParseError(
        `File is too large (${(selectedFile.size / 1024 / 1024).toFixed(1)} MB). Maximum size is ${MAX_FILE_SIZE_MB} MB (below the server's 10 MB request limit, leaving room for the upload envelope).`
      );
      resetFileInput();
      return;
    }

    // Read and parse the file. The generation captured here lets stale
    // readers (aborted or superseded) no-op instead of mutating state.
    const generation = fileGenRef.current;
    const reader = new FileReader();
    readerRef.current = reader;

    reader.onload = (e) => {
      if (fileGenRef.current !== generation) return; // Stale: superseded/unmounted.
      readerRef.current = null;
      // The file is only adopted once it parses: showing the green
      // has-file state for a malformed file would contradict the error.
      const fail = (message) => {
        setFile(null);
        resetFileInput();
        setParseError(message);
      };
      try {
        const data = JSON.parse(e.target.result);

        // Accept both formats: { parcels: [...] } or just [...]
        let parcelArray;
        if (Array.isArray(data)) {
          parcelArray = data;
        } else if (data && Array.isArray(data.parcels)) {
          parcelArray = data.parcels;
        } else {
          fail(
            'Invalid file format. Expected a JSON array of parcels, or an object with a "parcels" array. ' +
            'Example: [{ "weight": 2, "value": 100, "destinationCountry": "DE" }]'
          );
          return;
        }

        if (parcelArray.length === 0) {
          fail('File contains no parcels.');
          return;
        }

        setFile(selectedFile);
        setParcels(parcelArray);
        onClear();
      } catch {
        fail(
          'Failed to parse JSON. Please check the file format. ' +
          'Common issues: trailing commas, single quotes, or missing brackets.'
        );
      }
    };

    reader.onerror = () => {
      if (fileGenRef.current !== generation) return; // Stale: silent, not an error.
      readerRef.current = null;
      // Intentional aborts (unmount / newer file) are silent by design.
      if (reader.error?.name === 'AbortError') return;
      setParseError('Failed to read file. Please try again.');
    };

    reader.onabort = () => {
      if (readerRef.current === reader) readerRef.current = null;
    };

    reader.readAsText(selectedFile);
  }

  // --- Drag and drop handlers ---
  function handleDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }

  function handleFileInput(e) {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  }

  /**
   * Sends the parsed parcels to the backend for async processing.
   * POST /api/batches -> 202 -> poll GET /api/batches/:id -> results are
   * paged (BatchResults loads one page at a time, so 10k-parcel batches
   * never blow up the DOM or need silent truncation).
   */
  async function handleProcess() {
    if (!parcels || parcels.length === 0 || submittingRef.current) return;

    submittingRef.current = true;
    // One idempotency key per user action: if our own response is lost and
    // the operator retries, the server returns the original batch instead
    // of creating a duplicate.
    const idempotencyKey = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setProcessing(true);
    setProgress({ status: 'QUEUED', processed: 0, total: parcels.length, progress: 0 });
    onClear();

    try {
      const created = await createBatch(parcels, { signal, idempotencyKey });
      const finalStatus = await pollBatchStatus(created.batchId, {
        intervalMs: 1000,
        signal,
        onProgress: (batch) => setProgress(batch),
      });
      // Only the count is needed up front; pages load on demand.
      const firstPage = await fetchBatchResults(created.batchId, { limit: 1, signal });
      onBatchResult({
        batch: finalStatus,
        resultCount: firstPage.resultCount,
      });
    } catch (err) {
      if (isAbortError(err)) return; // Unmounted/replaced: silent, not a failure.
      onError(err);
    } finally {
      // Only touch state if this run is still current: after unmount the
      // cleanup already nulled the ref, so a late finally is a full no-op.
      if (abortRef.current === controller) {
        abortRef.current = null;
        submittingRef.current = false;
        setProcessing(false);
      }
    }
  }

  /**
   * Cancels the running batch flow (long 10k-parcel batches can take
   * minutes). File + parsed parcels are kept so the operator can retry
   * immediately; the late poll aborts silently and never delivers a result.
   */
  function handleCancel() {
    abortBatchFlow();
  }

  /**
   * Resets the upload form. Also cancels any pending file read so a late
   * onload can never repopulate the cleared form.
   */
  function handleReset() {
    fileGenRef.current++;
    readerRef.current?.abort();
    readerRef.current = null;
    abortBatchFlow();
    setFile(null);
    setParcels(null);
    setParseError(null);
    resetFileInput();
    onClear();
  }

  return (
    <div className="batch-upload">
      <h2>Batch Upload</h2>

      {/* Drop zone */}
      <div
        className={`drop-zone ${dragActive ? 'drag-active' : ''} ${file ? 'has-file' : ''}`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileInput}
          className="file-input-hidden"
          id="batch-file-input"
        />

        {!file ? (
          <>
            <div className="drop-zone-icon">📁</div>
            <p className="drop-zone-text">
              Drag and drop a JSON file here, or <span className="drop-zone-link">browse</span>
            </p>
            <p className="drop-zone-hint">Supports .json files up to {MAX_FILE_SIZE_MB} MB</p>
          </>
        ) : (
          <>
            <div className="drop-zone-icon">✅</div>
            <p className="drop-zone-text">{file.name}</p>
            <p className="drop-zone-hint">
              {(file.size / 1024).toFixed(1)} KB
              {parcels && ` · ${parcels.length.toLocaleString()} parcel${parcels.length !== 1 ? 's' : ''} detected`}
            </p>
          </>
        )}
      </div>

      {/* Parse error */}
      {parseError && (
        <div className="batch-parse-error">
          <p>⚠️ {parseError}</p>
        </div>
      )}

      {/* File format hint */}
      {!file && !parseError && (
        <div className="batch-format-hint">
          <p className="format-hint-title">Expected JSON format:</p>
          <pre className="format-example">
{`{
  "parcels": [
    {
      "weight": 2.5,
      "value": 150,
      "destinationCountry": "DE"
    },
    {
      "weight": 0.3,
      "value": 50,
      "destinationCountry": "FR"
    }
  ]
}`}
          </pre>
        </div>
      )}

      {/* Async progress: operator-facing circular indicator only.
          Polling behavior is unchanged — only the presentation is minimal:
          ring + percentage. No status text, counts, UUID, or bars. */}
      {processing && progress && (() => {
        const pct = typeof progress.progress === 'number'
          ? Math.min(100, Math.max(0, Math.round(progress.progress)))
          : 0;
        return (
          <div className="batch-progress-ring" role="status" aria-label={`Processing ${pct} percent`}>
            <div className="batch-progress-circle" style={{ '--p': `${pct}%` }}>
              <span className="batch-progress-value">{pct}%</span>
            </div>
          </div>
        );
      })()}

      {/* Actions */}
      <div className="form-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleProcess}
          disabled={!parcels || processing}
        >
          {processing
            ? 'Processing…'
            : parcels
              ? `Process ${parcels.length.toLocaleString()} Parcel${parcels.length !== 1 ? 's' : ''}`
              : 'Process Batch'
          }
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleReset}
          disabled={processing}
        >
          Clear
        </button>
        {processing && (
          <button
            type="button"
            className="btn-secondary"
            onClick={handleCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
