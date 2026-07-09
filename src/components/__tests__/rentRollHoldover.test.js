// Render smoke test for the rent roll's holdover badge + vacancy row. Mounts the
// REAL component against the demo mock (DEMO mode forced by the test env) so a render
// crash or a missing field surfaces here rather than only in the browser.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PropertyRentRoll from '../PropertyRentRoll';
import { updateLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderWithClient(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => cleanup());

describe('PropertyRentRoll — holdover + vacancy', () => {
  it('flags a held-over (expired-term) tenant on the roll', async () => {
    // City Dental (lease-2, prop-1) term ended 2026-05-31 → held over. Flip it outdated too.
    await updateLease('lease-2', { is_active: false });
    renderWithClient(<PropertyRentRoll propertyId="prop-1" year={Y} vacantSf={0} />);
    await waitFor(() => expect(screen.getByText('City Dental')).toBeTruthy());
    // The holdover badge renders with the "needs extension" suffix for an is_active=false lease.
    expect(screen.getByText(/Expired — held over · needs extension/)).toBeTruthy();
  });

  it('renders a Vacant space row when the building has unleased SF', async () => {
    renderWithClient(<PropertyRentRoll propertyId="prop-2" year={Y} vacantSf={1000} />);
    await waitFor(() => expect(screen.getByText('Vacant space')).toBeTruthy());
    expect(screen.getByText(/nothing to collect/)).toBeTruthy();
  });

  it('shows no vacancy row when fully leased', async () => {
    renderWithClient(<PropertyRentRoll propertyId="prop-1" year={Y} vacantSf={0} />);
    await waitFor(() => expect(screen.getByText(/Monthly rent roll/)).toBeTruthy());
    expect(screen.queryByText('Vacant space')).toBeNull();
  });
});
