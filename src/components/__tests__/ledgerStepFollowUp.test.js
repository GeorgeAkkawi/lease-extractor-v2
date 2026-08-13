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
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
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
const verdictIn = (row) => row.querySelector('.rr-step-verdict');
const noteIn = (row) => row.querySelector('.rr-step-note');

describe('LedgerPage — did the tenant pick up the raise?', () => {
  it('a lease with no applied step shows neither line', async () => {
    renderLedger();
    const row = await rowFor('City Dental');
    expect(noteIn(row)).toBeNull();
    expect(verdictIn(row)).toBeNull();
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

    // The existing cue still names the raise…
    expect(noteIn(row).textContent).toMatch(/rent raised to .* in Jun/);
    // …and the new line says what that increase is MADE OF. City Dental carries CAM & tax,
    // and it did not move — so the line says so rather than leaving it to be inferred.
    // This is George's question in one sentence.
    const madeOf = within(row).getByText(/the bill went up/);
    expect(madeOf.textContent).toContain(`$${STEP}.00`);
    expect(madeOf.textContent).toContain('in Jun');
    expect(madeOf.textContent).toContain('all of it base rent');

    // Nothing settled since June yet — and it says that, rather than reading a shortfall
    // into months no cheque has been recorded against.
    expect(verdictIn(row).textContent).toContain('nothing recorded since the raise yet');
    cleanup();
  });

  it('the cheque never followed: short by exactly the step, every month since', async () => {
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: OLD_MONTHLY, source: 'manual' });
    await markMonthPaid('lease-2', 'prop-1', Y, 7, { amount: OLD_MONTHLY, source: 'manual' });
    renderLedger();
    const row = await rowFor('City Dental');
    const v = verdictIn(row);
    expect(v.textContent).toContain('still at the pre-raise rate');
    expect(v.textContent).toContain(`$${STEP}.00/mo since Jun`);
    expect(v.textContent).toContain('$700.00 over 2 months');
    expect(v.querySelector('.rr-step-bad')).toBeTruthy();
    cleanup();
  });

  it('…and flips to picked up once the months settle at the new bill', async () => {
    // Through the affordance the month panel actually offers — "Record $X received" on a
    // month that settled short — rather than by rewriting history.
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: STEP, additional: true, source: 'manual' });
    await markMonthPaid('lease-2', 'prop-1', Y, 7, { amount: STEP, additional: true, source: 'manual' });
    renderLedger();
    const row = await rowFor('City Dental');
    const v = verdictIn(row);
    expect(v.textContent).toContain('picked up');
    expect(v.textContent).not.toContain('short');
    expect(v.querySelector('.rr-step-ok')).toBeTruthy();
    // The unstepped tenant beside it still shows neither line.
    const other = screen.getByText('Bright Coffee Co.').closest('tr');
    expect(noteIn(other)).toBeNull();
    expect(verdictIn(other)).toBeNull();
    cleanup();
  });
});
