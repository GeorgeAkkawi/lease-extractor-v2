// Render smoke test for the Rent Ledger page (Stage 1): mounts the REAL LedgerPage
// against the demo mock (DEMO mode forced by the test env) so a render crash or a
// missing field surfaces here rather than only in the browser. The demo seed gives
// it every state at once: Bright Coffee's untagged lump (pool-covered ✓ months),
// City Dental's tagged Jan/Feb + untagged partial (◐ March), open months, the
// holdover badge, and the Collected/Owes column.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../ConfirmDialog';
import LedgerPage from '../../pages/LedgerPage';
import { updateLease, markMonthPaid, unmarkMonthPaid } from '../../lib/api';
import { currentYear } from '../../lib/format';

function renderLedger(propId = 'prop-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-1/${propId}/ledger`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
              <Route path="/financials/:corpId/:propId" element={<div>financials-page</div>} />
            </Routes>
          </ConfirmProvider>
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
    // Bright Coffee's untagged $78,000 lump settles its whole year → pool-covered ✓
    // cells, each now showing the amount it drew (a figureless faded ✓ read as a
    // button that hadn't pressed).
    expect(document.querySelectorAll('.rr-cell.paid.pool').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$6,500').length).toBe(12);
    // Collected reads "$X of $Y billed": Bright $78,000.00 of $78,000.00 → 100%.
    expect(screen.getByText('$78,000.00')).toBeTruthy();
    expect(screen.getByText('of $78,000.00 billed')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    // City Dental: Jan + Feb tagged (full months), $4,000 untagged partial → a ◐ cell,
    // and collected $22,300.00 of the $109,800.00 billed.
    expect(screen.getAllByText('◐').length).toBeGreaterThan(0);
    expect(screen.getByText('$22,300.00')).toBeTruthy();
    expect(screen.getByText('of $109,800.00 billed')).toBeTruthy();
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

  // 0073 — every tenant states how its expenses are recovered, so a gross row's lower
  // base doesn't read as a mis-priced net one. BOTH states are labeled: leaving net rows
  // blank would make "no chip" ambiguous between triple net and never-recorded.
  it('labels every tenant NNN or Gross, and the label follows the toggle', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const chips = [...document.querySelectorAll('.lease-type-chip')];
    expect(chips.length).toBe(2);                                   // one per tenant row
    expect(chips.every((c) => c.textContent === 'NNN')).toBe(true); // the seed is all net

    cleanup();
    await updateLease('lease-1', { lease_type: 'gross' });
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const bright = screen.getByText('Bright Coffee Co.').closest('tr');
    const dental = screen.getByText('City Dental').closest('tr');
    expect(bright.querySelector('.lease-type-chip').textContent).toBe('Gross');
    expect(dental.querySelector('.lease-type-chip').textContent).toBe('NNN'); // unaffected
    await updateLease('lease-1', { lease_type: null });
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
    expect(screen.getByText(/🤖 Suggest buckets/)).toBeTruthy();
    // Clicking it sets a suggestion (canned in demo) with the AI chip — UNCHECKED.
    fireEvent.click(screen.getByText(/🤖 Suggest buckets/));
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
    // ⚠ THE "SECURITY DEPOSIT FROM…" PICKER ON THE UNPLACED PANEL LISTS REAL TENANTS.
    // It read `t.lease_id` off the row WRAPPER ({ r, alloc, comp, summary }), so every
    // option was `value="deposit:undefined"` with a blank label — an optgroup of empty
    // rows that would have filed a deposit against the string "undefined". Its only
    // symptom was React's "unique key" warning, which a production build never prints.
    const depositOpts = Array.from(document.querySelectorAll('optgroup[label="Security deposit from…"] option'));
    expect(depositOpts.length).toBeGreaterThan(0);
    for (const o of depositOpts) {
      expect(o.value).not.toMatch(/undefined/);
      expect(o.textContent.trim()).not.toBe('');
    }
    // The bank tie-out reads the same lines from the third angle and appears with them.
    expect(await screen.findByText('Where your bank money went')).toBeTruthy();
    // Undo from the results strip cleans everything back out.
    fireEvent.click(screen.getAllByText('↩ Undo')[0]);
    await waitFor(() => expect(screen.queryByText(/saved · Imported/)).toBeNull());
  });

  // ⚠ THE PANEL IS THERE BEFORE ANYTHING HAS BEEN IMPORTED, and it was not: it hung on
  // `tieOut &&`, which is null until a statement exists for the fiscal year, so on a property
  // with nothing imported the whole feature was invisible and indistinguishable from never
  // having been built (George, twice: "i still dont see the bank tie out button"). An empty
  // state has to SAY it is empty — "nothing to check" and "not here" must not look the same.
  it('shows the “Where your bank money went” panel before any statement is imported, saying what it is waiting for', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const toggle = (await screen.findByText('Where your bank money went')).closest('button.panel-toggle');
    expect(toggle).toBeTruthy();
    // Folded, it still states what it holds — Panel's own rule.
    expect(toggle.textContent).toMatch(new RegExp(`nothing imported for FY ${currentYear()} yet`));
    fireEvent.click(toggle);
    expect(screen.getByText(/No bank statement has been imported for FY/)).toBeTruthy();
    // ⚠ …and it says outright that empty is not the same as clean. A blank panel reading
    // "$0.00 ✓" would claim a bill of health nobody checked.
    expect(screen.getByText(/not the same as .checked and clean./)).toBeTruthy();
    // It names the way in, rather than leaving the landlord to find it — the same words
    // the button above it carries, which is why there are two matches.
    expect(screen.getAllByText(/Import statement/).length).toBeGreaterThan(1);
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

  it('a settled-SHORT month reads ✓ in a GOLD box, its card names the gap, and one click takes it back', async () => {
    const Y = currentYear();
    // Tag City Dental's April at only $5,000 of the $9,150 owed → settled short.
    await markMonthPaid('lease-2', 'prop-1', Y, 4, { amount: 5000 });
    renderLedger();
    await waitFor(() => expect(screen.getByText('City Dental')).toBeTruthy());
    // "paid = paid": a recorded payment marks the month paid whatever the amount — there is
    // NO amber "short" cell state (its removal is a deliberate earlier fix).
    expect(document.querySelector('.rr-cell.paid.short')).toBeNull();
    // ⚠ THE BOX ITSELF carries the difference now (2026-08-17), not only its figure —
    // George overriding his own earlier "only the FIGURE tints" call. $5,000 against
    // April's $9,150 bill → a gold ✓ box, and the row still states the gap.
    const aprCell = document.querySelector('.rent-roll button.rr-cell.paid.off');
    expect(aprCell).toBeTruthy();
    expect(within(aprCell).getByText('$5,000')).toBeTruthy();
    // Once on City Dental's row, once on the all-tenants total (it's the only gap).
    expect(screen.getAllByText('short $4,150.00')).toHaveLength(2);

    // Hovering says WHAT HAPPENED, which is the whole point of the card.
    fireEvent.mouseEnter(aprCell);
    const card = document.querySelector('.tipcard');
    expect(card.textContent).toContain('Apr · City Dental');
    expect(card.textContent).toContain('$4,150.00 under the bill');
    expect(card.textContent).toContain('take this month back');
    fireEvent.mouseLeave(aprCell);

    // DOUBLE-click opens the month (single click is the toggle now).
    fireEvent.dblClick(aprCell);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /April/ })).toBeTruthy());
    const panel = screen.getByRole('dialog', { name: /April/ });
    expect(within(panel).getByText('Still owed')).toBeTruthy();
    expect(within(panel).getByText('$4,150.00')).toBeTruthy();
    // …and "Undo this month" has LEFT the panel — the grid does it in one click.
    expect(within(panel).queryByText('Undo this month')).toBeNull();
    fireEvent.click(within(panel).getByLabelText('Close'));

    // One click on the box takes April back. The payment was recorded by hand and there is
    // only one of it, so nothing is asked first.
    fireEvent.click(aprCell);
    await waitFor(() => expect(document.querySelector('.rent-roll button.rr-cell.paid.off')).toBeNull(), { timeout: 3000 });
    await unmarkMonthPaid('lease-2', Y, 4); // clean up (no-op if already undone)
  });

  // A brand-new tenant's first deposits arrive before the lease's own year bills
  // anything. That money used to be re-pooled onto the first month the lease DID bill —
  // silently settling a month nobody paid. It stays where it landed and says so.
  it('a payment recorded for a month the lease bills nothing for reads "received, not billed"', async () => {
    const Y = currentYear();
    // Sunrise Yoga's lease commences July 1 — its FY bills nothing Jan–Jun.
    await markMonthPaid('lease-4', 'prop-2', Y, 5, { amount: 2716 });
    renderLedger('prop-2');
    await waitFor(() => expect(screen.getByText('Sunrise Yoga Studio')).toBeTruthy());

    const recv = document.querySelector('.rent-roll .rr-cell.recv');
    expect(recv).toBeTruthy();
    expect(within(recv).getByText('$2,716')).toBeTruthy();
    // It settles no charge, so it can't read as a paid month.
    expect(recv.className).not.toContain('paid');
    // The card says why: the lease bills nothing for May, so the money sits where it landed.
    fireEvent.mouseEnter(recv);
    expect(document.querySelector('.tipcard').textContent).toContain('May · Sunrise Yoga Studio');
    fireEvent.mouseLeave(recv);

    await unmarkMonthPaid('lease-4', Y, 5);
  });
});
