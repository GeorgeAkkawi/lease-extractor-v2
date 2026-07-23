// Render smoke test for the Rent Ledger page (Stage 1): mounts the REAL LedgerPage
// against the demo mock (DEMO mode forced by the test env) so a render crash or a
// missing field surfaces here rather than only in the browser. The demo seed gives
// it every state at once: Bright Coffee's untagged lump (pool-covered ✓ months),
// City Dental's tagged Jan/Feb + untagged partial (◐ March), open months, the
// holdover badge, and the Collected/Owes column.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
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
  it('renders the grid with mixed coverage states and the Collected-of-projected column', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(screen.getByText('City Dental')).toBeTruthy();
    // Single Collected column now — the Owes column is gone.
    expect(screen.getByRole('columnheader', { name: 'Collected' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Owes' })).toBeNull();
    // Bright Coffee's untagged $78,000 lump settles its whole year → ✓ cells.
    expect(screen.getAllByText('✓').length).toBeGreaterThan(0);
    // Collected reads "$X of $Y": Bright $78,000.00 of $78,000.00 → 100%.
    expect(screen.getByText('$78,000.00')).toBeTruthy();
    expect(screen.getByText('of $78,000.00')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    // City Dental: Jan + Feb tagged (full months), $4,000 untagged partial → a ◐ cell,
    // and collected $22,300.00 of the $109,800.00 projected.
    expect(screen.getAllByText('◐').length).toBeGreaterThan(0);
    expect(screen.getByText('$22,300.00')).toBeTruthy();
    expect(screen.getByText('of $109,800.00')).toBeTruthy();
    // Each settled (tagged) month now shows its received dollar figure in the box, not
    // just a bare ✓ (George: "the number doesnt show up"). City Dental's Jan + Feb are
    // tagged at $9,150 each → two "$9,150" cell amounts.
    expect(screen.getAllByText('$9,150').length).toBeGreaterThanOrEqual(2);
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

  it('statement import round-trip: sample → review screen → save → results strip + register', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    // The demo sandbox offers the bundled sample statement.
    fireEvent.click(screen.getByText('Try a sample statement'));
    await waitFor(() => expect(screen.getByText(/Review statement/)).toBeTruthy());
    // Both groups render, the expense property is stated, and lines parsed honestly.
    expect(screen.getByText(/Money in · 3/)).toBeTruthy();
    expect(screen.getByText(/Money out · 6/)).toBeTruthy();
    expect(screen.getByText(/Expenses will be recorded on:/)).toBeTruthy();
    expect(screen.getByText(/9 lines parsed · 0 skipped/)).toBeTruthy();
    expect(screen.getByText('✓ Accept all confident')).toBeTruthy();
    // The mortgage line auto-suggests ignore with its reason shown.
    expect(screen.getByText(/mortgage payment is not a recoverable CAM expense/)).toBeTruthy();
    // The keyword hits land in named BUCKETS (0064): garbage → Waste removal,
    // snow → Snow removal, each pre-picked in the bucket dropdown.
    const pickValues = Array.from(document.querySelectorAll('.stmt-table select')).map((s) => s.value);
    expect(pickValues).toContain('cam:Waste removal');
    expect(pickValues).toContain('cam:Snow removal');
    // The unrecognized Home Depot line surfaces the click-gated 🤖 button.
    expect(screen.getByText(/🤖 Suggest buckets for 1 line/)).toBeTruthy();
    // Clicking it sets a suggestion (canned in demo) with the AI chip — UNCHECKED.
    fireEvent.click(screen.getByText(/🤖 Suggest buckets for 1 line/));
    await waitFor(() => expect(screen.getAllByText('AI').length).toBeGreaterThan(0));
    const aiPick = Array.from(document.querySelectorAll('.stmt-table select')).map((s) => s.value);
    expect(aiPick).toContain('cam:Repairs & supplies');
    const aiRow = screen.getByTitle('AI suggestion — tick the checkbox to accept it').closest('tr');
    expect(aiRow.querySelector('input[type="checkbox"]').checked).toBe(false);
    // Save whatever the matcher pre-checked (the clean deposits + tax + CAM lines).
    fireEvent.click(screen.getByText('Save to ledger'));
    await waitFor(() => expect(screen.getByText(/saved · Imported sample-statement.pdf/)).toBeTruthy());
    // The register lists the import with an Undo.
    expect(screen.getByText(/Imported statements \(1\)/)).toBeTruthy();
    // Undo from the results strip cleans everything back out.
    fireEvent.click(screen.getAllByText('↩ Undo')[0]);
    await waitFor(() => expect(screen.queryByText(/saved · Imported/)).toBeNull());
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
