/**
 * Approval helpers — generic presentation of backend approval decisions.
 *
 * The backend owns approval semantics and returns approvals dynamically.
 * The UI understands only a normalized list of { type, reason } and must
 * NEVER branch on specific approval types (Insurance, Manual Review, or
 * any future rule): a new backend approval type renders automatically.
 */

/**
 * Normalizes backend approval data into ONE generic representation:
 * Array<{ type: string, reason: string }>.
 *
 * Accepts:
 * - objects: { type, reason } (batch results, detailed single-parcel)
 * - plain type strings (single-parcel summary shape)
 * - nullish / non-array input → []
 *
 * Entries without a usable type are dropped; missing reasons become ''.
 */
export function normalizeApprovals(approvals) {
  if (!Array.isArray(approvals)) return [];
  const out = [];
  for (const a of approvals) {
    if (typeof a === 'string') {
      if (a) out.push({ type: a, reason: '' });
    } else if (a && typeof a === 'object' && typeof a.type === 'string' && a.type) {
      out.push({ type: a.type, reason: typeof a.reason === 'string' ? a.reason : '' });
    }
  }
  return out;
}
