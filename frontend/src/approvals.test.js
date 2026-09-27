import { describe, it, expect } from 'vitest';
import { approvalTypeOf, hasInsuranceApproval } from './approvals.js';

describe('hasInsuranceApproval', () => {
  it('no approvals → Insurance not required', () => {
    expect(hasInsuranceApproval([])).toBe(false);
    expect(hasInsuranceApproval(undefined)).toBe(false);
    expect(hasInsuranceApproval(null)).toBe(false);
  });

  it('Insurance approval (object form) → Insurance required', () => {
    expect(hasInsuranceApproval([{ type: 'Insurance', reason: 'Value exceeds €1,000.' }])).toBe(true);
  });

  it('Insurance approval (string form) → Insurance required', () => {
    expect(hasInsuranceApproval(['Insurance'])).toBe(true);
  });

  it('Manual Review only → Insurance NOT required', () => {
    expect(hasInsuranceApproval([{ type: 'Manual Review', reason: 'Value exceeds €5,000.' }])).toBe(false);
    expect(hasInsuranceApproval(['Manual Review'])).toBe(false);
  });

  it('multiple approvals including Insurance → Insurance required', () => {
    expect(
      hasInsuranceApproval([
        { type: 'Insurance', reason: 'Value exceeds €1,000.' },
        { type: 'Manual Review', reason: 'Value exceeds €5,000.' },
      ]),
    ).toBe(true);
  });
});

describe('approvalTypeOf', () => {
  it('passes strings through and reads object types', () => {
    expect(approvalTypeOf('Insurance')).toBe('Insurance');
    expect(approvalTypeOf({ type: 'Manual Review' })).toBe('Manual Review');
    expect(approvalTypeOf(undefined)).toBeUndefined();
  });
});
