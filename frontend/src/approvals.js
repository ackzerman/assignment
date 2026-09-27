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

// Small deterministic palette for approval-type badges. The mapping is
// derived from the type string itself, so ANY current or future approval
// type gets a stable, readable badge with zero per-type UI logic.
const APPROVAL_BADGE_PALETTE = [
  { background: '#1d4ed8', color: '#ffffff' }, // blue
  { background: '#047857', color: '#ffffff' }, // green
  { background: '#b45309', color: '#ffffff' }, // amber
  { background: '#6d28d9', color: '#ffffff' }, // violet
  { background: '#be185d', color: '#ffffff' }, // pink
  { background: '#0e7490', color: '#ffffff' }, // cyan
];

/**
 * Returns { background, color } badge styling deterministically derived
 * from the approval type. Unknown/future types just work.
 */
export function approvalBadgeStyle(type) {
  const text = String(type ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return APPROVAL_BADGE_PALETTE[hash % APPROVAL_BADGE_PALETTE.length];
}
