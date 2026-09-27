// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { routeParcel, fetchCountries } from './api.js';
import ParcelForm from './components/ParcelForm.jsx';

vi.mock('./api.js', () => ({
  routeParcel: vi.fn(),
  fetchCountries: vi.fn(async () => ['DE', 'FR', 'NG']),
}));

function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/Weight/), { target: { value: '2.5' } });
  fireEvent.change(screen.getByLabelText(/Value/), { target: { value: '150' } });
  fireEvent.change(screen.getByLabelText(/Destination Country/), { target: { value: 'DE' } });
}

describe('ParcelForm request lifecycle + guards', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.mocked(routeParcel).mockReset();
    vi.mocked(fetchCountries).mockClear();
    vi.mocked(fetchCountries).mockResolvedValue(['DE', 'FR', 'NG']);
  });

  it('stale completion after unmount never touches callbacks', async () => {
    let resolveRoute;
    vi.mocked(routeParcel).mockImplementation(
      () => new Promise((resolve) => { resolveRoute = resolve; }),
    );
    const onResult = vi.fn();
    const onError = vi.fn();
    const { unmount } = render(
      <ParcelForm onResult={onResult} onError={onError} onClear={vi.fn()} />,
    );
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /Route Parcel|Routing/ }));
    await waitFor(() => expect(routeParcel).toHaveBeenCalledTimes(1));

    unmount();
    resolveRoute({ data: { department: 'Regular' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects zero weight client-side without a network call', async () => {
    const onResult = vi.fn();
    render(<ParcelForm onResult={onResult} onError={vi.fn()} onClear={vi.fn()} />);
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/Weight/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Route Parcel|Routing/ }));
    expect(await screen.findByText('Weight must be greater than 0.')).toBeTruthy();
    expect(routeParcel).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('rejects duplicate attribute keys without a network call', async () => {
    render(<ParcelForm onResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Add Attribute/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add Attribute/ }));
    const keyInputs = screen.getAllByPlaceholderText(/Key \(e.g. fragile\)/);
    fireEvent.change(keyInputs[0], { target: { value: 'fragile' } });
    fireEvent.change(keyInputs[1], { target: { value: 'fragile' } });
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /Route Parcel|Routing/ }));
    expect(await screen.findByText(/Duplicate attribute key "fragile"/)).toBeTruthy();
    expect(routeParcel).not.toHaveBeenCalled();
  });

  it('labels every backend country code (no raw-code-only options)', async () => {
    render(<ParcelForm onResult={vi.fn()} onError={vi.fn()} onClear={vi.fn()} />);
    expect(await screen.findByText(/Germany \(DE\)/)).toBeTruthy();
    expect(screen.getByText(/France \(FR\)/)).toBeTruthy();
    expect(screen.getByText(/Nigeria \(NG\)/)).toBeTruthy();
  });
});
