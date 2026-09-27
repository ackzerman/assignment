// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RoutingResult from './components/RoutingResult.jsx';

// Approval headings render as "✓ {type}" inside <strong>.
const strongWith = (text) =>
  screen.getByText((_, el) => el?.tagName === 'STRONG' && (el.textContent || '').includes(text));

function parcelResult(overrides = {}) {  return {
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

  it('Insurance approval renders type + Required + reason', () => {
    render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: ['Insurance'],
          approvalsDetail: [{ type: 'Insurance', reason: 'Parcel value exceeds €1,000.' }],
        })}
      />,
    );
    expect(strongWith("Insurance")).toBeTruthy();
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0);
    expect(screen.getByText('Parcel value exceeds €1,000.')).toBeTruthy();
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
    expect(strongWith("Manual Review")).toBeTruthy();
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
    expect(strongWith("Insurance")).toBeTruthy();
    expect(strongWith("Manual Review")).toBeTruthy();
    expect(screen.getAllByText('Required')).toHaveLength(2);
  });

  it('a future approval type renders without code changes', () => {
    render(
      <RoutingResult
        result={parcelResult({
          requiresApproval: true,
          approvals: [{ type: 'Manager Approval', reason: 'High-value parcel requires manager review.' }],
        })}
      />,
    );
    expect(strongWith("Manager Approval")).toBeTruthy();
    expect(screen.getByText('High-value parcel requires manager review.')).toBeTruthy();
    expect(screen.getAllByText('Required')).toHaveLength(1);
  });
});
