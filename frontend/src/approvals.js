/**
 * Approval helpers — pure functions shared by result components.
 *
 * The backend supports multiple approval types (e.g. "Insurance",
 * "Manual Review"). The "Insurance" indicator must reflect an Insurance
 * approval specifically — never the generic requiresApproval flag, which is
 * true for ANY approval type.
 */

/**
 * Normalizes one approval entry to its type string.
 * Batch results carry objects ({ type, reason }); single-parcel results
 * may carry plain type strings.
 */
export function approvalTypeOf(approval) {
  if (typeof approval === 'string') return approval;
  return approval?.type;
}

/**
 * Whether the approval list contains an Insurance approval specifically.
 */
export function hasInsuranceApproval(approvals) {
  return Array.isArray(approvals) && approvals.some((a) => approvalTypeOf(a) === 'Insurance');
}
