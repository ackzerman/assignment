/**
 * ApprovalItem — one generic approval row shared by the single-parcel and
 * batch result views.
 *
 * Renders the approval TYPE as a colored badge (same visual treatment as
 * department badges, colors derived deterministically from the type string
 * so future backend approval types work with no component changes),
 * followed by a small secondary "Required" status badge, with the
 * backend-provided reason directly underneath.
 *
 * Structure:
 *   [ Type ] [ Required ]
 *   reason text…
 */
import { approvalBadgeStyle } from '../approvals';

export default function ApprovalItem({ approval }) {
  const style = approvalBadgeStyle(approval.type);
  return (
    <>
      <span
        className="approval-type-badge dept-badge-sm"
        style={{ backgroundColor: style.background, color: style.color }}
      >
        {approval.type}
      </span>{' '}
      <span className="approval-badge required">Required</span>
      {approval.reason ? (
        <div className="reason-text">{approval.reason}</div>
      ) : null}
    </>
  );
}
