// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { fetchBatchResults } from './api.js';
import BatchResults from './components/BatchResults.jsx';

vi.mock('./api.js', () => ({
  fetchBatchResults: vi.fn(),
}));

// Approval types render as colored badges (span.dept-badge-sm).
const badgeWith = (text) => screen.getByText(text, { selector: 'span.dept-badge-sm' });

const batch = {
  batchId: 'BATCH-1',
  status: 'COMPLETED',
  total: 2,
  successful: 1,
  failed: 1,
  progress: 100,
  completedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

function rowsFor(extraRow) {
  return [
    {
      parcelId: 'P1',
      index: 0,
      status: 'routed',
      department: 'Regular',
      requiresApproval: true,
      approvals: [{ type: 'Insurance', reason: 'Parcel value exceeds €1,000.' }],
      matchedRules: ['department.regular', 'approval.insurance'],
      reasons: ['Parcel weight (5kg) is between 1kg and 10kg.'],
      errors: null,
      inputSummary: { weight: 5, value: 2000, destinationCountry: 'DE' },
    },
    extraRow,
  ];
}

describe('BatchResults approvals (generic, data-driven)', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.mocked(fetchBatchResults).mockReset();
  });

  async function expandFirstRow() {
    const buttons = await screen.findAllByRole('button', { name: 'View' });
    fireEvent.click(buttons[0]);
  }

  it('renders each approval as badge + Required + reason, no rule IDs', async () => {
    fetchBatchResults.mockResolvedValue({
      results: rowsFor({
        parcelId: 'P2',
        index: 1,
        status: 'routed',
        department: 'Heavy',
        requiresApproval: true,
        approvals: [
          { type: 'Insurance', reason: 'Parcel value exceeds €1,000.' },
          { type: 'Manual Review', reason: 'Needs a human look.' },
        ],
        matchedRules: ['department.heavy', 'approval.insurance', 'approval.manual-review'],
        reasons: ['Heavy parcel.'],
        errors: null,
        inputSummary: { weight: 15, value: 6000, destinationCountry: 'US' },
      }),
      resultCount: 2,
    });
    const { container } = render(<BatchResults data={{ batch, resultCount: 2 }} />);
    await expandFirstRow();

    expect(badgeWith('Insurance')).toBeTruthy();
    expect(screen.getByText('Parcel value exceeds €1,000.')).toBeTruthy();
    // Raw rule IDs are never operator content.
    expect(screen.queryByText(/approval\.insurance/)).toBeNull();
    expect(screen.queryByText(/department\.regular/)).toBeNull();
    // No checkmarks in the expanded approval details.
    expect(container.querySelector('.batch-detail-panel').textContent).not.toContain('✓');
  });

  it('Manual Review only shows no Insurance indicator', async () => {
    fetchBatchResults.mockResolvedValue({
      results: [
        {
          parcelId: 'P1',
          index: 0,
          status: 'routed',
          department: 'Regular',
          requiresApproval: true,
          approvals: [{ type: 'Manual Review', reason: 'Needs a human look.' }],
          matchedRules: ['department.regular', 'approval.manual-review'],
          reasons: ['Regular parcel.'],
          errors: null,
          inputSummary: { weight: 5, value: 6000, destinationCountry: 'DE' },
        },
      ],
      resultCount: 1,
    });
    render(<BatchResults data={{ batch, resultCount: 1 }} />);
    await expandFirstRow();

    expect(badgeWith('Manual Review')).toBeTruthy();
    expect(screen.getAllByText('Required')).toHaveLength(1);
    expect(screen.queryByText('Insurance')).toBeNull();
  });

  it('a future approval type renders without code changes', async () => {
    fetchBatchResults.mockResolvedValue({
      results: [
        {
          parcelId: 'P9',
          index: 0,
          status: 'routed',
          department: 'Heavy',
          requiresApproval: true,
          approvals: [{ type: 'Customs Approval', reason: 'Customs check needed.' }],
          matchedRules: ['department.heavy'],
          reasons: ['Heavy parcel.'],
          errors: null,
          inputSummary: { weight: 20, value: 100, destinationCountry: 'US' },
        },
      ],
      resultCount: 1,
    });
    render(<BatchResults data={{ batch, resultCount: 1 }} />);
    await expandFirstRow();

    expect(badgeWith('Customs Approval')).toBeTruthy();
    expect(screen.getByText('Customs check needed.')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Required')).toHaveLength(1));
  });

  it('shows status in the heading and the UUID only as a secondary reference', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const { container } = render(<BatchResults data={{ batch, resultCount: 0 }} />);

    const metaText = container.querySelector('.batch-meta').textContent;
    expect(metaText).toContain('Batch COMPLETED');
    expect(metaText).toContain('Batch reference: BATCH-1');
    // Raw UUID is not the prominent heading.
    expect(metaText).not.toContain('Batch BATCH-1');
  });
});
