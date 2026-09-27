/**
 * BatchResults — Displays batch processing results clearly.
 *
 * Design Decisions:
 *
 * 1. SUMMARY FIRST — Show totals (successful/failed) prominently at the top.
 *    Operators need to know the overall health of the batch immediately.
 *
 * 2. TABULAR RESULTS — Individual results shown in a scannable table.
 *    Each row shows status, department, and errors at a glance.
 *
 * 3. FILTER CONTROLS — Operators can filter to see only failed parcels
 *    to fix issues, or only successful ones to confirm routing.
 *
 * 4. COLLAPSIBLE DETAILS — Error details are shown inline but don't
 *    overwhelm the view when there are many results.
 */

import { useState } from 'react';

// Department display colors (same as RoutingResult)
const DEPT_COLORS = {
  Mail: '#3b82f6',
  Regular: '#10b981',
  Heavy: '#f59e0b',
};

export default function BatchResults({ data }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'routed' | 'invalid'
  const [expandedRows, setExpandedRows] = useState(new Set());

  if (!data) return null;

  // Support both legacy sync shape { summary, results } and async shape { batch, results }.
  const batch = data.batch || null;
  const summary = data.summary || (batch
    ? {
        total: batch.total,
        successful: batch.successful,
        failed: batch.failed,
        processedAt: batch.completedAt || batch.createdAt,
      }
    : { total: 0, successful: 0, failed: 0 });
  const results = data.results || [];

  // Apply filter
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

  // Count departments for the summary breakdown
  const deptCounts = {};
  for (const r of results) {
    if (r.status === 'routed' && r.department) {
      deptCounts[r.department] = (deptCounts[r.department] || 0) + 1;
    }
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

      {/* Department Breakdown */}
      {Object.keys(deptCounts).length > 0 && (
        <div className="dept-breakdown">
          <span className="dept-breakdown-label">Department breakdown:</span>
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

      {/* Filter Controls */}
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
          ✓ Routed ({summary.successful})
        </button>
        <button
          className={`filter-btn ${filter === 'invalid' ? 'active' : ''}`}
          onClick={() => setFilter('invalid')}
        >
          ✗ Failed ({summary.failed})
        </button>
      </div>

      {/* Results Table */}
      <div className="batch-table-wrapper">
        <table className="batch-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Department</th>
              <th>Insurance</th>
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
                    r.requiresApproval ? (
                      <span className="approval-badge-sm required">Required</span>
                    ) : (
                      <span className="approval-badge-sm not-required">No</span>
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

      {/* Expanded detail panels (shown below table for selected rows) */}
      {filteredResults
        .filter((r) => expandedRows.has(r.index))
        .map((r) => (
          <div key={`detail-${r.index}`} className="batch-detail-panel">
            <div className="detail-panel-header">
              Parcel #{r.index + 1} — {r.status === 'routed' ? 'Routing Details' : 'Validation Errors'}
            </div>
            {r.status === 'routed' ? (
              <div className="detail-panel-body">
                <div className="detail-grid">
                  <span className="detail-key">Department:</span>
                  <span>{r.department}</span>
                  <span className="detail-key">Reason:</span>
                  <span className="reason-text">{r.departmentReason}</span>
                  <span className="detail-key">Weight:</span>
                  <span>{r.parcel.weight} kg</span>
                  <span className="detail-key">Value:</span>
                  <span>€{r.parcel.value.toLocaleString()}</span>
                  <span className="detail-key">Country:</span>
                  <span>{r.parcel.destinationCountry}</span>
                </div>
                {r.approvals && r.approvals.length > 0 && (
                  <div className="detail-approvals">
                    <span className="detail-key">Approvals:</span>
                    <ul>
                      {r.approvals.map((a, i) => (
                        <li key={i}>{a.type}: {a.reason}</li>
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
                {r.input && (
                  <div className="detail-input">
                    <span className="detail-key">Submitted data:</span>
                    <pre>{JSON.stringify(r.input, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

      {/* Metadata */}
      <div className="result-meta">
        Processed at {new Date(summary.processedAt).toLocaleString()}
      </div>
    </div>
  );
}
