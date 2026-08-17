// The Ledger's answer to "did the tenant actually pick up the raise?" (George,
// 2026-08-13), driven through the REAL LedgerPage against the demo mock.
//
// The verdict math is pinned in escalationFollowThrough.test.js; what this file exists
// for is the glue nothing else covers — that the two new lines render, that they print
// the decomposition George asked for ("what the payment increase should have been on the
// base"), and that they flip with the money.
//
// ⚠ TWO applied steps are required to produce a step at all, and that is monthlyBases'
// documented behaviour rather than a quirk of this fixture: with only ONE applied step in
// the whole history, every month reads the live base_rent (months before it "fall back to
// current best"), so the year is flat and escalationStepMonths correctly finds nothing. A
// lease that has stepped more than once carries the earlier row; a lease on its very
// first raise does not, and shows no verdict until the year after. Worth knowing before
// wondering why a fixture with one escalation renders nothing.
//
// ⚠ City Dental, not Bright Coffee, because Bright Coffee's seeded $78,000 UNTAGGED lump
// pools forward and quietly covers any shortfall you try to create — which is correct
// behaviour (the money did arrive) and useless as a fixture. City Dental's $4,000 partial
// is exhausted by March, so June onward is clean.
//
// ⚠ The demo store persists across tests in this file, so these run in sequence and each
// evolves the state the previous one left.
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../ConfirmDialog';
import LedgerPage from '../../pages/LedgerPage';
import { updateLease, createEscalation, markMonthPaid } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const OLD_BASE = 84000;          // City Dental's seeded base — $7,000/mo
const NEW_BASE = 88200;          // a 5% step from June → +$350/mo
const OLD_MONTHLY = 9150;        // base + CAM & tax, the seeded bill
const NEW_MONTHLY = 9500;        // after the step
const STEP = 350;

function renderLedger() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/financials/corp-1/prop-1/ledger']}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
            </Routes>
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// The row a tenant's name sits in, so one row's absence of a note can't be satisfied by
// another row's presence of one.
const rowFor = async (name) => {
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  return screen.getByText(name).closest('tr');
};
// The raise is ONE chip now, with the whole story on its hover card (2026-08-17) — three
// printed lines under the tenant's name is exactly what George read back as noise. So the
// assertions hover the chip and read the card, which keeps the coverage on the sentences
// themselves rather than on where they happened to be printed.
const chipIn = (row) => row.querySelector('.rr-raise');
const cardFor = (row) => {
  fireEvent.mouseEnter(chipIn(row));
  return document.querySelector('.tipcard');
};

describe('LedgerPage — did the tenant pick up the raise?', () => {
  it('a lease with no applied step shows no raise chip at all', async () => {
    renderLedger();
    const row = await rowFor('City Dental');
    expect(chipIn(row)).toBeNull();
    cleanup();
  });

  it('the raise lands: says what the bill went up by, and that nothing has come in yet', async () => {
    await updateLease('lease-2', { base_rent: NEW_BASE });
    await createEscalation({
      lease_id: 'lease-2', effective_date: `${Y - 1}-01-01`, escalation_type: 'manual',
      new_base_rent: OLD_BASE, status: 'applied', applied_at: `${Y - 1}-01-01`,
    });
    await createEscalation({
      lease_id: 'lease-2', effective_date: `${Y}-06-01`, escalation_type: 'manual',
      new_base_rent: NEW_BASE, status: 'applied', applied_at: `${Y}-06-01`,
    });
    renderLedger();
    const row = await rowFor('City Dental');

    // The chip names the month at a glance…
    expect(chipIn(row).textContent).toContain('Jun raise');

    // …and the card states the raise as a BEFORE AND AFTER, which is the part three
    // sentences never actually said (George: "the rent raise effect isnt clear").
    const card = cardFor(row);
    // Monthly, because that is what a box on this row bills — the constants above are annual.
    expect(card.textContent).toContain(`$${(OLD_BASE / 12).toLocaleString('en-US')}.00 → $${(NEW_BASE / 12).toLocaleString('en-US')}.00`);
    expect(card.textContent).toContain('The whole bill');
    expect(card.textContent).toContain(`+$${STEP}.00/mo`);
    // City Dental carries CAM & tax and it did not move — so the card says so rather than
    // leaving it to be inferred. This is George's question in one sentence.
    expect(card.textContent).toContain('base rent');
    expect(card.textContent).toContain('CAM & tax estimate is unchanged');

    // Nothing settled since June yet — and it says that, rather than reading a shortfall
    // into months no cheque has been recorded against.
    expect(chipIn(row).textContent).toContain('nothing in yet');
    expect(card.textContent).toContain('Nothing has been recorded since the raise yet');
    cleanup();
  });

  it('the cheque never followed: short by exactly the step, every month since', async () => {
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: OLD_MONTHLY, source: 'manual' });
    await markMonthPaid('lease-2', 'prop-1', Y, 7, { amount: OLD_MONTHLY, source: 'manual' });
    renderLedger();
    const row = await rowFor('City Dental');
    expect(chipIn(row).className).toContain('rr-raise-bad');
    const card = cardFor(row);
    expect(card.textContent).toContain('still paying the pre-raise amount');
    expect(card.textContent).toContain(`$${STEP}.00/mo since Jun`);
    expect(card.textContent).toContain('$700.00 over 2 months');
    cleanup();
  });

  it('…and flips to picked up once the months settle at the new bill', async () => {
    // Through the affordance the month panel actually offers — "Record $X received" on a
    // month that settled short — rather than by rewriting history.
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: STEP, additional: true, source: 'manual' });
    await markMonthPaid('lease-2', 'prop-1', Y, 7, { amount: STEP, additional: true, source: 'manual' });
    renderLedger();
    const row = await rowFor('City Dental');
    const chip = chipIn(row);
    expect(chip.textContent).toContain('picked up');
    expect(chip.textContent).not.toContain('short');
    expect(chip.className).toContain('rr-raise-ok');
    expect(cardFor(row).textContent).toContain('every one at the new bill');
    // The unstepped tenant beside it still shows no chip.
    const other = screen.getByText('Bright Coffee Co.').closest('tr');
    expect(chipIn(other)).toBeNull();
    cleanup();
  });
});
