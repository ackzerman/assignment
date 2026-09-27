/**
 * RoutingResult — Displays the routing decision clearly.
 *
 * Design Decisions:
 * - Department is shown prominently with a color-coded badge
 * - Department reason is displayed in natural language (not JSON)
 * - Approvals render generically from backend data (any approval type)
 * - Parcel details are summarized for confirmation
 *
 * This component receives the raw API result and presents it
 * in a way non-technical operators can understand immediately.
 */

// Department display colors
const DEPT_COLORS = {
  Mail: '#3b82f6',     // blue
  Regular: '#10b981',  // green
  Heavy: '#f59e0b',    // amber
};

import { normalizeApprovals } from '../approvals';

export default function RoutingResult({ result }) {
  if (!result) return null;

  const deptColor = DEPT_COLORS[result.department] || '#6b7280';
  // Single canonical representation: every approval renders dynamically.
  // Prefer detailed objects when present, fall back to the summary shape.
  const approvals = normalizeApprovals(
    result.approvalsDetail && result.approvalsDetail.length > 0
      ? result.approvalsDetail
      : result.approvals,
  );

  return (
    <div className="routing-result">
      <h2>Routing Decision</h2>

      {/* Department */}
      <div className="result-section">
        <div className="result-label">Department</div>
        <div className="result-value">
          <span
            className="dept-badge"
            style={{ backgroundColor: deptColor }}
          >
            {result.department}
          </span>
        </div>
      </div>

      {/* Department Reason */}
      <div className="result-section">
        <div className="result-label">Reason</div>
        <div className="result-value reason-text">
          {result.departmentReason}
        </div>
      </div>

      {/* Approvals: generic, data-driven. Every backend approval type
          renders automatically — no per-type UI logic. Listed approvals
          are all required; that is why they were returned. */}
      <div className="result-section">
        <div className="result-label">Approvals</div>
        <div className="result-value">
          {approvals.length > 0 ? (
            <ul className="approvals-list">
              {approvals.map((approval, index) => (
                <li key={index}>
                  <strong>✓ {approval.type}</strong>{' '}
                  <span className="approval-badge required">Required</span>
                  {approval.reason ? (
                    <div className="reason-text">{approval.reason}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="reason-text">No additional approval required.</span>
          )}
        </div>
      </div>

      {/* Parcel Summary */}
      <div className="result-section parcel-summary">
        <div className="result-label">Parcel Summary</div>
        <div className="result-value">
          <div className="summary-grid">
            <span className="summary-key">Weight:</span>
            <span>{result.parcel.weight} kg</span>
            <span className="summary-key">Value:</span>
            <span>€{result.parcel.value.toLocaleString()}</span>
            <span className="summary-key">Country:</span>
            <span>{result.parcel.destinationCountry}</span>
          </div>
          {result.parcel.additionalAttributes &&
            Object.keys(result.parcel.additionalAttributes).length > 0 && (
              <div className="summary-attrs">
                <span className="summary-key">Attributes:</span>
                {Object.entries(result.parcel.additionalAttributes).map(
                  ([key, val]) => (
                    <span key={key} className="attr-tag">
                      {key}: {String(val)}
                    </span>
                  )
                )}
              </div>
            )}
        </div>
      </div>

      {/* Metadata */}
      <div className="result-meta">
        Routed at {new Date(result.routedAt).toLocaleString()} · Rule: {result.departmentRule}
      </div>
    </div>
  );
}
