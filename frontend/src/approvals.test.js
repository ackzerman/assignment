import { describe, it, expect } from 'vitest';
import { normalizeApprovals, approvalBadgeStyle } from './approvals.js';

describe('normalizeApprovals (generic approval rendering)', () => {
  it('no approvals → empty list ("No additional approval required.")', () => {
    expect(normalizeApprovals([])).toEqual([]);
    expect(normalizeApprovals(undefined)).toEqual([]);
    expect(normalizeApprovals(null)).toEqual([]);
  });

  it('one approval renders with type and reason', () => {
    expect(
      normalizeApprovals([{ type: 'Insurance', reason: 'Value exceeds €1,000.' }]),
    ).toEqual([{ type: 'Insurance', reason: 'Value exceeds €1,000.' }]);
  });

  it('multiple approvals all render', () => {
    expect(
      normalizeApprovals([
        { type: 'Insurance', reason: 'Value exceeds €1,000.' },
        { type: 'Manual Review', reason: 'Value exceeds €5,000.' },
      ]),
    ).toEqual([
      { type: 'Insurance', reason: 'Value exceeds €1,000.' },
      { type: 'Manual Review', reason: 'Value exceeds €5,000.' },
    ]);
  });

  it('a future approval type renders without code changes', () => {
    expect(
      normalizeApprovals([
        { type: 'Manager Approval', reason: 'High-value parcel requires manager review.' },
      ]),
    ).toEqual([
      { type: 'Manager Approval', reason: 'High-value parcel requires manager review.' },
    ]);
  });

  it('accepts plain type strings and fills missing reasons', () => {
    expect(normalizeApprovals(['Insurance'])).toEqual([{ type: 'Insurance', reason: '' }]);
  });

  it('drops entries without a usable type', () => {
    expect(normalizeApprovals([null, {}, { reason: 'no type' }, { type: '', reason: 'x' }])).toEqual([]);
  });
});

describe('approvalBadgeStyle (deterministic, data-driven colors)', () => {
  it('returns a readable background/color pair', () => {
    const style = approvalBadgeStyle('Insurance');
    expect(typeof style.background).toBe('string');
    expect(typeof style.color).toBe('string');
  });

  it('is deterministic per type', () => {
    expect(approvalBadgeStyle('Insurance')).toEqual(approvalBadgeStyle('Insurance'));
  });

  it('supports unknown future types without code changes', () => {
    const style = approvalBadgeStyle('Customs Approval');
    expect(typeof style.background).toBe('string');
    expect(typeof style.color).toBe('string');
  });
});
