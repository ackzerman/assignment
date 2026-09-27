import { useState, useRef } from 'react';
import { createBatch, pollBatchStatus, fetchBatchResults } from '../api';

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

// Maximum file size: 10MB (matches backend's express.json limit)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export default function BatchUpload({ onBatchResult, onError, onClear }) {
  const [file, setFile] = useState(null);
  const [parcels, setParcels] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  /**
   * Reads and parses a JSON file.
   * Validates structure before sending to the backend.
   */
  function handleFile(selectedFile) {
    // Reset state
    setParseError(null);
    setParcels(null);
    onClear();

    // Validate file type
    if (!selectedFile.name.endsWith('.json')) {
      setParseError('Please upload a JSON file (.json).');
      setFile(null);
      return;
    }

    // Validate file size
    if (selectedFile.size > MAX_FILE_SIZE) {
      setParseError(
        `File is too large (${(selectedFile.size / 1024 / 1024).toFixed(1)} MB). Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`
      );
      setFile(null);
      return;
    }

    setFile(selectedFile);

    // Read and parse the file
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);

        // Accept both formats: { parcels: [...] } or just [...]
        let parcelArray;
        if (Array.isArray(data)) {
          parcelArray = data;
        } else if (data && Array.isArray(data.parcels)) {
          parcelArray = data.parcels;
        } else {
          setParseError(
            'Invalid file format. Expected a JSON array of parcels, or an object with a "parcels" array. ' +
            'Example: [{ "weight": 2, "value": 100, "destinationCountry": "DE" }]'
          );
          return;
        }

        if (parcelArray.length === 0) {
          setParseError('File contains no parcels.');
          return;
        }

        setParcels(parcelArray);
      } catch {
        setParseError(
          'Failed to parse JSON. Please check the file format. ' +
          'Common issues: trailing commas, single quotes, or missing brackets.'
        );
      }
    };

    reader.onerror = () => {
      setParseError('Failed to read file. Please try again.');
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
   * Sends the parsed parcels to the backend for async processing (Master Phase 4/8).
   * POST /api/batches -> 202 -> poll GET /api/batches/:id -> GET results.
   */
  async function handleProcess() {
    if (!parcels || parcels.length === 0) return;

    setProcessing(true);
    setProgress({ status: 'QUEUED', processed: 0, total: parcels.length, progress: 0 });
    onClear();

    try {
      const created = await createBatch(parcels);
      const finalStatus = await pollBatchStatus(created.batchId, {
        intervalMs: 1000,
        onProgress: (batch) => setProgress(batch),
      });
      const resultsPayload = await fetchBatchResults(created.batchId, { limit: 1000 });
      onBatchResult({
        batch: finalStatus,
        results: resultsPayload.results,
        resultCount: resultsPayload.resultCount,
      });
    } catch (err) {
      onError(err);
    } finally {
      setProcessing(false);
    }
  }

  /**
   * Resets the upload form.
   */
  function handleReset() {
    setFile(null);
    setParcels(null);
    setParseError(null);
    setProcessing(false);
    setProgress(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
            <p className="drop-zone-hint">Supports .json files up to 10 MB</p>
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

      {/* Async progress (Master Phase 8: poll status, show progress) */}
      {processing && progress && (
        <div className="batch-progress">
          <p>
            Batch {progress.batchId || ''} — {progress.status}
            {typeof progress.processed === 'number' && typeof progress.total === 'number' && (
              <> · {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} processed</>
            )}
            {typeof progress.progress === 'number' && <> · {progress.progress}%</>}
          </p>
          {typeof progress.progress === 'number' && (
            <progress value={progress.progress} max="100" style={{ width: '100%' }} />
          )}
        </div>
      )}

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
      </div>
    </div>
  );
}
