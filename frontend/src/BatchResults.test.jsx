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

  it('COMPLETED displays the operator completion line without UUID', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const { container } = render(<BatchResults data={{ batch, resultCount: 0 }} />);

    expect(screen.getByText('Batch completed · 100%')).toBeTruthy();
    expect(container.textContent).not.toContain('BATCH-1');
    expect(container.textContent).not.toContain('COMPLETED_WITH_ERRORS');
  });

  it('COMPLETED_WITH_ERRORS displays the same operator line, never the internal string', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const errorBatch = { ...batch, status: 'COMPLETED_WITH_ERRORS', successful: 1, failed: 1 };
    const { container } = render(<BatchResults data={{ batch: errorBatch, resultCount: 0 }} />);

    expect(screen.getByText('Batch completed · 100%')).toBeTruthy();
    expect(container.textContent).not.toContain('COMPLETED_WITH_ERRORS');
    expect(container.textContent).not.toContain('BATCH-1');
    // The Failed summary card still communicates the errors.
    const failedCard = container.querySelector('.summary-failed .summary-card-number');
    expect(failedCard).toBeTruthy();
    expect(failedCard.textContent).toBe('1');
  });

  it('FAILED still displays "Batch failed" with the Failed count, without UUID', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const failedBatch = { ...batch, status: 'FAILED', error: 'Worker crashed' };
    const { container } = render(<BatchResults data={{ batch: failedBatch, resultCount: 0 }} />);

    expect(screen.getByText('Batch failed')).toBeTruthy();
    expect(container.textContent).not.toContain('BATCH-1');
    const failedCard = container.querySelector('.summary-failed .summary-card-number');
    expect(failedCard).toBeTruthy();
  });

  it('FAILED without counts renders zeros instead of crashing', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const bareBatch = { batchId: 'BATCH-9', status: 'FAILED', error: 'Worker crashed' };
    const { container } = render(<BatchResults data={{ batch: bareBatch, resultCount: 0 }} />);

    expect(screen.getByText('Batch failed')).toBeTruthy();
    const numbers = [...container.querySelectorAll('.summary-card-number')].map((n) => n.textContent);
    expect(numbers).toEqual(['0', '0', '0']);
  });

  it('invalid rows without error details render a fallback instead of crashing', async () => {
    fetchBatchResults.mockResolvedValue({
      results: [
        {
          parcelId: 'P1',
          index: 0,
          status: 'invalid',
          errors: undefined,
          inputSummary: { weight: -1, value: 10, destinationCountry: 'DE' },
        },
      ],
      resultCount: 1,
    });
    render(<BatchResults data={{ batch, resultCount: 1 }} />);
    const buttons = await screen.findAllByRole('button', { name: 'View' });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('No error details recorded for this parcel.')).toBeTruthy();
  });

  it('missing processedAt renders a neutral timestamp line', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    const timeless = { ...batch };
    delete timeless.completedAt;
    delete timeless.createdAt;
    render(<BatchResults data={{ batch: timeless, resultCount: 0 }} />);
    expect(await screen.findByText('Processed time unavailable')).toBeTruthy();
  });

  it('filter controls are labeled as current-page scope', async () => {
    fetchBatchResults.mockResolvedValue({ results: [], resultCount: 0 });
    render(<BatchResults data={{ batch, resultCount: 0 }} />);
    expect(await screen.findByText('Filters (current page):')).toBeTruthy();
  });
});
