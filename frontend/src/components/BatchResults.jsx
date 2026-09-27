/**
 * BatchResults — Displays batch processing results with pagination.
 *
 * Design Decisions:
 *
 * 1. SUMMARY FIRST — Show totals (successful/failed) prominently at the top.
 *    Operators need to know the overall health of the batch immediately.
 *
 * 2. PAGINATED TABLE — Only one page of rows (200) is ever in the DOM, so a
 *    10,000-parcel batch is fully inspectable via Prev/Next without loading
 *    huge result lists into the DOM at once. Pages load progressively from
 *    GET /api/batches/:batchId/results?limit=&offset=.
 *
 * 3. FILTER CONTROLS — Operate on the loaded page ( counts shown per page ).
 *
 * 4. COLLAPSIBLE DETAILS — Error details are shown inline but don't
 *    overwhelm the view when there are many results.
 */

import { useState, useEffect } from 'react';
import { fetchBatchResults } from '../api';
import { PAGE_SIZE, pageCountFor, clampPage } from '../pagination';
import { normalizeApprovals } from '../approvals';

// Department display colors (same as RoutingResult)
const DEPT_COLORS = {
  Mail: '#3b82f6',
  Regular: '#10b981',
  Heavy: '#f59e0b',
};

export default function BatchResults({ data }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'routed' | 'invalid'
  const [expandedRows, setExpandedRows] = useState(new Set());
  // Page state (rows/loading/error travel together; remount via key resets per batch).
  const [pageState, setPageState] = useState(() => ({
    page: 0,
    rows: [],
    loading: !!(data?.batch?.batchId && !data?.results),
    error: null,
  }));

  const batch = data?.batch || null;
  const batchId = batch?.batchId || null;
  const resultCount = typeof data?.resultCount === 'number' ? data.resultCount : 0;
  const pageCount = pageCountFor(resultCount, PAGE_SIZE);

  // Support the legacy embedded shape { summary, results } if ever passed.
  const legacyRows = Array.isArray(data?.results) ? data.results : null;

  useEffect(() => {
    if (!batchId || legacyRows) return;
    let cancelled = false;
    fetchBatchResults(batchId, { limit: PAGE_SIZE, offset: pageState.page * PAGE_SIZE }).then(
      (payload) => {
        if (cancelled) return;
        setPageState((s) => ({ ...s, rows: payload.results || [], loading: false, error: null }));
        setExpandedRows(new Set());
      },
      (err) => {
        if (cancelled) return;
        setPageState((s) => ({ ...s, rows: [], loading: false, error: err.message || 'Failed to load results page.' }));
      },
    );
    return () => { cancelled = true; };
  }, [batchId, pageState.page, legacyRows]);

  if (!data) return null;

  const summary = data.summary || (batch
    ? {
        total: batch.total,
        successful: batch.successful,
        failed: batch.failed,
        processedAt: batch.completedAt || batch.createdAt,
      }
    : { total: 0, successful: 0, failed: 0 });
  const results = legacyRows || pageState.rows;
  const { page, loading } = pageState;
  const loadError = pageState.error;

  // Apply filter to the loaded page
  const filteredResults = results.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'routed') return r.status === 'routed';
    if (filter === 'invalid') return r.status !== 'routed';
    return true;
  });

  function toggleRow(index) {
    const next = new Set(expandedRows);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setExpandedRows(next);
  }

  // Department breakdown for the loaded page
  const deptCounts = {};
  for (const r of results) {
    if (r.status === 'routed' && r.department) {
      deptCounts[r.department] = (deptCounts[r.department] || 0) + 1;
    }
  }

  function goToPage(next) {
    const clamped = clampPage(next, pageCount);
    if (clamped === pageState.page) return;
    // Event handler (not an effect): safe to flag loading synchronously.
    setPageState((s) => ({ ...s, page: clamped, loading: true, error: null }));
  }

  return (
    <div className="batch-results">
      <h2>Batch Results</h2>

      {batch && (
        <div className="batch-meta">
          <p>
            Batch {batch.batchId} — {batch.status}
            {typeof batch.progress === 'number' && <> · {batch.progress}%</>}
          </p>
        </div>
      )}

      {/* Summary Cards */}
      <div className="batch-summary">
        <div className="summary-card summary-total">
          <div className="summary-card-number">{summary.total.toLocaleString()}</div>
          <div className="summary-card-label">Total</div>
        </div>
        <div className="summary-card summary-success">
          <div className="summary-card-number">{summary.successful.toLocaleString()}</div>
          <div className="summary-card-label">Routed</div>
        </div>
        <div className="summary-card summary-failed">
          <div className="summary-card-number">{summary.failed.toLocaleString()}</div>
          <div className="summary-card-label">Failed</div>
        </div>
      </div>

      {/* Department Breakdown (current page) */}
      {Object.keys(deptCounts).length > 0 && (
        <div className="dept-breakdown">
          <span className="dept-breakdown-label">Department breakdown (current page):</span>
          {Object.entries(deptCounts).map(([dept, count]) => (
            <span
              key={dept}
              className="dept-breakdown-tag"
              style={{ backgroundColor: DEPT_COLORS[dept] || '#6b7280' }}
            >
              {dept}: {count.toLocaleString()}
            </span>
          ))}
        </div>
      )}

      {/* Filter Controls (current page) */}
      <div className="batch-filters">
        <button
          className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({results.length})
        </button>
        <button
          className={`filter-btn ${filter === 'routed' ? 'active' : ''}`}
          onClick={() => setFilter('routed')}
        >
          ✓ Routed ({results.filter((r) => r.status === 'routed').length})
        </button>
        <button
          className={`filter-btn ${filter === 'invalid' ? 'active' : ''}`}
          onClick={() => setFilter('invalid')}
        >
          ✗ Failed ({results.filter((r) => r.status !== 'routed').length})
        </button>
      </div>

      {loadError && (
        <div className="batch-parse-error">
          <p>⚠️ {loadError}</p>
        </div>
      )}

      {/* Results Table (one page in the DOM at a time) */}
      <div className="batch-table-wrapper">
        <table className="batch-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Department</th>
              <th>Approvals</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {filteredResults.map((r) => (
              <tr key={r.index} className={`batch-row ${r.status}`}>
                <td className="batch-cell-index">{r.index + 1}</td>
                <td>
                  <span className={`status-badge status-${r.status}`}>
                    {r.status === 'routed' ? '✓ Routed' : '✗ Invalid'}
                  </span>
                </td>
                <td>
                  {r.status === 'routed' ? (
                    <span
                      className="dept-badge-sm"
                      style={{ backgroundColor: DEPT_COLORS[r.department] || '#6b7280' }}
                    >
                      {r.department}
                    </span>
                  ) : (
                    <span className="na-text">—</span>
                  )}
                </td>
                <td>
                  {r.status === 'routed' ? (
                    normalizeApprovals(r.approvals).length > 0 ? (
                      <span className="approval-badge-sm required">
                        {normalizeApprovals(r.approvals).map((a) => a.type).join(', ')}
                      </span>
                    ) : (
                      <span className="approval-badge-sm not-required">None</span>
                    )
                  ) : (
                    <span className="na-text">—</span>
                  )}
                </td>
                <td>
                  <button
                    className="btn-details"
                    onClick={() => toggleRow(r.index)}
                  >
                    {expandedRows.has(r.index) ? 'Hide' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {loading && <p>Loading results…</p>}

      {!loading && !legacyRows && resultCount === 0 && (
        <p className="na-text">No results stored for this batch.</p>
      )}

      {/* Expanded detail panels (shown below table for selected rows) */}
      {filteredResults
        .filter((r) => expandedRows.has(r.index))
        .map((r) => (
          <div key={`detail-${r.index}`} className="batch-detail-panel">
            <div className="detail-panel-header">
              Parcel #{r.index + 1}{r.parcelId ? ` (${r.parcelId})` : ''} — {r.status === 'routed' ? 'Routing Details' : 'Validation Errors'}
            </div>
            {r.status === 'routed' ? (
              <div className="detail-panel-body">
                <div className="detail-grid">
                  <span className="detail-key">Department:</span>
                  <span>{r.department}</span>
                  <span className="detail-key">Reason:</span>
                  <span className="reason-text">{r.departmentReason || (r.reasons && r.reasons[0]) || '—'}</span>
                  <span className="detail-key">Weight:</span>
                  <span>{(r.parcel || r.inputSummary)?.weight ?? '—'} kg</span>
                  <span className="detail-key">Value:</span>
                  <span>€{((r.parcel || r.inputSummary)?.value ?? 0).toLocaleString()}</span>
                  <span className="detail-key">Country:</span>
                  <span>{(r.parcel || r.inputSummary)?.destinationCountry || '—'}</span>
                </div>
                {/* Internal rule IDs are intentionally NOT shown.
                    Each approval renders generically with its own reason. */}
                {normalizeApprovals(r.approvals).length > 0 && (
                  <div className="detail-approvals">
                    <span className="detail-key">Approvals:</span>
                    <ul>
                      {normalizeApprovals(r.approvals).map((a, i) => (
                        <li key={i}>
                          <strong>✓ {a.type}</strong>{' '}
                          <span className="approval-badge required">Required</span>
                          {a.reason ? (
                            <div className="reason-text">{a.reason}</div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="detail-panel-body">
                <ul className="detail-errors">
                  {r.errors.map((err, i) => (
                    <li key={i}>
                      <strong>{err.field}:</strong> {err.message}
                    </li>
                  ))}
                </ul>
                {(r.input || r.inputSummary) && (
                  <div className="detail-input">
                    <span className="detail-key">Submitted data:</span>
                    <pre>{JSON.stringify(r.input || r.inputSummary, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

      {/* Pagination */}
      {!legacyRows && resultCount > 0 && (
        <div className="batch-filters">
          <button
            className="filter-btn"
            onClick={() => goToPage(page - 1)}
            disabled={page === 0 || loading}
          >
            ← Prev
          </button>
          <span className="na-text">
            Page {page + 1} of {pageCount} · {resultCount.toLocaleString()} total results
          </span>
          <button
            className="filter-btn"
            onClick={() => goToPage(page + 1)}
            disabled={page >= pageCount - 1 || loading}
          >
            Next →
          </button>
        </div>
      )}

      {/* Metadata */}
      <div className="result-meta">
        Processed at {new Date(summary.processedAt).toLocaleString()}
      </div>
    </div>
  );
}
