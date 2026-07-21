// Render smoke test for the Rent Ledger page (Stage 1): mounts the REAL LedgerPage
// against the demo mock (DEMO mode forced by the test env) so a render crash or a
// missing field surfaces here rather than only in the browser. The demo seed gives
// it every state at once: Bright Coffee's untagged lump (pool-covered ✓ months),
// City Dental's tagged Jan/Feb + untagged partial (◐ March), open months, the
// holdover badge, and the Collected/Owes column.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import LedgerPage from '../../pages/LedgerPage';
import { updateLease } from '../../lib/api';

function renderLedger(propId = 'prop-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-1/${propId}/ledger`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
            <Route path="/financials/:corpId/:propId" element={<div>financials-page</div>} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => cleanup());

describe('LedgerPage — the rent ledger grid', () => {
  it('renders the grid with mixed coverage states and the Collected/Owes columns', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(screen.getByText('City Dental')).toBeTruthy();
    // Column headers.
    expect(screen.getByText('Collected')).toBeTruthy();
    expect(screen.getByText('Owes')).toBeTruthy();
    // Bright Coffee's untagged $78,100 lump settles its whole year → paid ✓.
    expect(screen.getAllByText('paid ✓').length).toBeGreaterThan(0);
    expect(screen.getByText('$78,100.00')).toBeTruthy();
    // City Dental: Jan + Feb tagged, $4,000 untagged partial → a ◐ cell exists.
    expect(screen.getAllByText('◐').length).toBeGreaterThan(0);
    // Its collected-so-far figure: 8,208.33 + 8,208.33 + 4,000.
    expect(screen.getByText('$20,416.66')).toBeTruthy();
  });

  it('shows the base | CAM&tax component sub-line on each tenant', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    // The identity sub-line reads "$X/mo = $B base · $C CAM&tax…" — at least one row has it.
    expect(screen.getAllByText(/base · .*CAM&tax/).length).toBeGreaterThan(0);
  });

  it('flags a held-over (expired-term) tenant on the ledger', async () => {
    await updateLease('lease-2', { is_active: false });
    renderLedger();
    await waitFor(() => expect(screen.getByText('City Dental')).toBeTruthy());
    expect(screen.getByText(/Expired — held over · needs extension/)).toBeTruthy();
    await updateLease('lease-2', { is_active: true });
  });

  it('renders a Vacant space row when the building has unleased SF', async () => {
    // The demo buildings are fully leased, so make real vacancy: shrink Sunrise Yoga
    // (prop-2) to 500 SF → Oak Center reads 6,000 building − 5,500 leased = 500 vacant.
    await updateLease('lease-4', { square_footage: 500 });
    renderLedger('prop-2');
    await waitFor(() => expect(screen.getByText('Vacant space')).toBeTruthy());
    expect(screen.getByText(/nothing to collect/)).toBeTruthy();
    await updateLease('lease-4', { square_footage: 1000 });
  });
});
