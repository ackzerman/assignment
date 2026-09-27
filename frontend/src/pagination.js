/**
 * Pagination helpers for batch result viewing.
 *
 * Pure functions (no React, no DOM) so the paging math the UI relies on
 * is unit-testable: every result in a large batch must be reachable through
 * some page, and page navigation must stay within bounds.
 */

export const PAGE_SIZE = 200;

/**
 * Number of pages needed to view resultCount results.
 * Always at least 1 so the pager renders a stable "Page 1 of 1" state.
 */
export function pageCountFor(resultCount, pageSize = PAGE_SIZE) {
  const total = Number.isFinite(resultCount) && resultCount > 0 ? resultCount : 0;
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
  return Math.max(1, Math.ceil(total / size));
}

/**
 * Clamps a page index into [0, pageCount - 1].
 */
export function clampPage(page, pageCount) {
  const count = Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1;
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.floor(page)), count - 1);
}

/**
 * Offset for a page index with the given page size.
 */
export function offsetFor(page, pageSize = PAGE_SIZE) {
  return clampPage(page, Number.MAX_SAFE_INTEGER) * pageSize;
}
