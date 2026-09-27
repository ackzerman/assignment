/**
 * RoutingResult — Displays the routing decision clearly.
 *
 * Design Decisions:
 * - Department is shown prominently with a color-coded badge
 * - Reasons are displayed in natural language (not JSON)
 * - Insurance/approvals are clearly labeled as Required or Not Required
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

import { hasInsuranceApproval } from '../approvals';

export default function RoutingResult({ result }) {
  if (!result) return null;

  const deptColor = DEPT_COLORS[result.department] || '#6b7280';
  // Master shape returns approvals as string array; legacy returns objects.
  // Prefer detailed objects when present.
  const approvalsDetail = result.approvalsDetail
    || (Array.isArray(result.approvals) && result.approvals.length > 0 && typeof result.approvals[0] === 'object'
      ? result.approvals
      : []);
  const requiresInsurance = hasInsuranceApproval(result.approvalsDetail || result.approvals);

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

      {/* Approvals: Insurance column reflects an Insurance approval
          specifically — NOT the generic requiresApproval flag (which is
          also true for e.g. Manual Review). */}
      <div className="result-section">
        <div className="result-label">Insurance</div>
        <div className="result-value">
          {requiresInsurance ? (
            <span className="approval-badge required">Required</span>
          ) : (
            <span className="approval-badge not-required">Not Required</span>
          )}
        </div>
      </div>

      {/* Approval Details */}
      {approvalsDetail && approvalsDetail.length > 0 && (
        <div className="result-section">
          <div className="result-label">Approval Details</div>
          <div className="result-value">
            <ul className="approvals-list">
              {approvalsDetail.map((approval, index) => (
                <li key={index}>
                  <strong>{approval.type}:</strong> {approval.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Master explainability: matched rules + reasons */}
      {result.matchedRules && result.matchedRules.length > 0 && (
        <div className="result-section">
          <div className="result-label">Matched Rules</div>
          <div className="result-value">
            <div className="reason-text">{result.matchedRules.join(', ')}</div>
          </div>
        </div>
      )}

      {result.reasons && result.reasons.length > 0 && (
        <div className="result-section">
          <div className="result-label">Reasons</div>
          <div className="result-value">
            <ul className="approvals-list">
              {result.reasons.map((reason, index) => (
                <li key={index} className="reason-text">{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

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
