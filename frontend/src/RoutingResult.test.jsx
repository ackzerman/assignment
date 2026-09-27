// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RoutingResult from './components/RoutingResult.jsx';

// Approval types render as colored badges (span.dept-badge-sm).
const badgeWith = (text) => screen.getByText(text, { selector: 'span.dept-badge-sm' });

function parcelResult(overrides = {}) {
  return {
    parcelId: 'P1',
    department: 'Regular',
    departmentReason: 'Parcel weight (5kg) is between 1kg and 10kg.',
    approvals: [],
    matchedRules: ['department.regular'],
    reasons: ['Parcel weight (5kg) is between 1kg and 10kg.'],
    requiresApproval: false,
    approvalsDetail: [],
    parcel: { weight: 5, value: 100, destinationCountry: 'DE', additionalAttributes: {} },
    routedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    departmentRule: 'regular-department',
    ...overrides,
  };
}

describe('RoutingResult approvals (generic, data-driven)', () => {
  afterEach(() => {
    cleanup();
  });

  it('no approvals → neutral message, no Reasons section', () => {
    render(<RoutingResult result={parcelResult()} />);
    expect(screen.getByText('No additional approval required.')).toBeTruthy();
    // Department "Reason" stays; the duplicate "Reasons" section is gone.
    expect(screen.getByText('Reason')).toBeTruthy();
    expect(screen.queryByText('Reasons')).toBeNull();
  });

  it('Insurance approval renders as badge + separate Required badge + reason', () => {
    const { container } = render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: ['Insurance'],
          approvalsDetail: [{ type: 'Insurance', reason: 'Parcel value exceeds €1,000.' }],
        })}
      />,
    );
    const badge = badgeWith('Insurance');
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('dept-badge-sm');
    const required = screen.getAllByText('Required');
    expect(required).toHaveLength(1);
    expect(required[0].className).toContain('approval-badge');
    expect(required[0].tagName).toBe('SPAN');
    expect(screen.getByText('Parcel value exceeds €1,000.')).toBeTruthy();
    // No checkmarks anywhere in the approvals UI.
    expect(container.querySelector('.approvals-list').textContent).not.toContain('✓');
    expect(screen.queryByText('Reasons')).toBeNull();
  });

  it('Manual Review only renders without any Insurance indicator', () => {
    render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: ['Manual Review'],
          approvalsDetail: [{ type: 'Manual Review', reason: 'Needs a human look.' }],
        })}
      />,
    );
    expect(badgeWith('Manual Review')).toBeTruthy();
    expect(screen.queryByText('Insurance')).toBeNull();
    expect(screen.queryByText('Reasons')).toBeNull();
  });

  it('multiple approvals all render with Required badges', () => {
    render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: ['Insurance', 'Manual Review'],
          approvalsDetail: [
            { type: 'Insurance', reason: 'Parcel value exceeds €1,000.' },
            { type: 'Manual Review', reason: 'Needs a human look.' },
          ],
        })}
      />,
    );
    expect(badgeWith('Insurance')).toBeTruthy();
    expect(badgeWith('Manual Review')).toBeTruthy();
    expect(screen.getAllByText('Required')).toHaveLength(2);
  });

  it('a future approval type renders without code changes', () => {
    const { container } = render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: [{ type: 'Manager Approval', reason: 'High-value parcel requires manager review.' }],
        })}
      />,
    );
    expect(badgeWith('Manager Approval')).toBeTruthy();
    expect(screen.getByText('High-value parcel requires manager review.')).toBeTruthy();
    expect(screen.getAllByText('Required')).toHaveLength(1);
    expect(container.querySelector('.approvals-list').textContent).not.toContain('✓');
  });

  it('a synthetic future approval type renders generically with a bold Required badge', () => {
    const { container } = render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: [{ type: 'Quantum Clearance', reason: 'Parcel exhibits quantum tunneling.' }],
        })}
      />,
    );
    // Approval type itself is a colored badge (same treatment as departments).
    const badge = badgeWith('Quantum Clearance');
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('dept-badge-sm');
    // Required is its own separate badge carrying the required class.
    const required = screen.getAllByText('Required');
    expect(required).toHaveLength(1);
    expect(required[0].tagName).toBe('SPAN');
    expect(required[0].className).toContain('approval-badge');
    expect(required[0].className).toContain('required');
    // Reason sits underneath as separate text.
    expect(screen.getByText('Parcel exhibits quantum tunneling.')).toBeTruthy();
    // Never a checkmark.
    expect(container.querySelector('.approvals-list').textContent).not.toContain('✓');
  });
});
