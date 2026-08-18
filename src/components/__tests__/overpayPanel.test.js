// The month pop-up's answer to "what is this surplus?", driven through the REAL Ledger.
//
// George, 2026-08-17: *"those shortage and overpayments shouldnt be recorded live until the
// user confirms them … i want under or over payments highlighted."*
//
// ⚠ THE ARITHMETIC IS PINNED ELSEWHERE (overpayDecision.test.js, against the real write
// paths). What this file exists for is the glue nothing else covers, and it is the half that
// would fail silently: the live workbook now WITHHOLDS money from revenue, and the only route
// to release it is this panel. A held figure with no working way to answer for it is worse
// than the behaviour it replaced — the landlord's money would simply be missing.
//
// ⚠ prop-2, because the demo seed carries a `financial_snapshots` row for prop-1's CURRENT
// year — that property is CLOSED and every write refuses, correctly.
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../ConfirmDialog';
import LedgerPage from '../../pages/LedgerPage';
import { ensureInvoice, recordPayment, getPropertyMonthlyRoll } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function renderLedger() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/financials/corp-2/prop-2/ledger']}>
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

/** Over-pay one month of Northwind Books (lease-3) by a known figure. */
async function overpay(month, surplus) {
  const inv = await ensureInvoice('lease-3', 'prop-2', Y);
  const row = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-3');
  const owed = round2(Number(row.schedule[month].owed) || 0);
  expect(owed, 'the month must bill something, or the whole cheque is surplus').toBeGreaterThan(0);
  await recordPayment({
    invoice_id: inv.id, lease_id: 'lease-3', amount: round2(owed + surplus),
    paid_date: `${Y}-${String(month).padStart(2, '0')}-04`, method: 'check',
    period_month: month, source: 'manual',
  });
  return owed;
}

describe('an over-paid month asks what the surplus is', () => {
  it('rings the box, and the pop-up offers the three answers instead of a paragraph', async () => {
    await overpay(4, 1750);
    renderLedger();
    await screen.findByText('Northwind Books');

    // ⚠ THE BOX IS THE THING THAT SAYS SO. The money is being withheld from the live income
    // figures; if the grid looked like any other settled month, it would be withheld invisibly.
    const cell = await waitFor(() => {
      const found = document.querySelector('.rr-cell.awaiting');
      expect(found).toBeTruthy();
      return found;
    });
    expect(cell.getAttribute('aria-label')).toMatch(/not yet applied/);

    fireEvent.doubleClick(cell);
    const panel = await screen.findByRole('dialog');
    // The paragraph that used to explain why nothing could be done is gone…
    expect(within(panel).queryByText(/does not move to another month by itself/)).toBeNull();
    // …and the figure is named as being in none of the income.
    expect(within(panel).getByText(/more arrived than/)).toBeTruthy();

    // ⚠ NO GATE — every answer is there the moment the month is opened (George: *"i shouldnt
    // have to click what is this 100 there should just be quick options"*).
    expect(within(panel).queryByRole('button', { name: /What is this/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: /^Revenue for /   })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^Revenue always$/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^Refund$/ })).toBeTruthy();
    // The next month is one click; every other month is in the picker beside it.
    expect(within(panel).getByRole('button', { name: /^Roll to May$/ })).toBeTruthy();
    expect(within(panel).getByRole('combobox', { name: /Roll \$1,750\.00 forward to another month/ })).toBeTruthy();
    // Leaving it is not clicking, so there is no button for doing nothing.
    expect(within(panel).queryByRole('button', { name: /Leave it for now/ })).toBeNull();
    cleanup();
  });

  // ⚠ THE ROUND TRIP THAT MATTERS: answering must actually clear the ring, or the landlord
  // answers the same question forever and the money never reaches the sheet.
  it('counts it as revenue when told to, and the box stops asking', async () => {
    await overpay(7, 900);
    renderLedger();
    await screen.findByText('Northwind Books');
    const cell = await waitFor(() => {
      const found = [...document.querySelectorAll('.rr-cell.awaiting')]
        .find((el) => /\$900\.00 not yet applied/.test(el.getAttribute('aria-label') || ''));
      expect(found).toBeTruthy();
      return found;
    });

    fireEvent.doubleClick(cell);
    const panel = await screen.findByRole('dialog');
    fireEvent.click(within(panel).getByRole('button', { name: /^Revenue for / }));
    // The confirm names where the money lands before it moves — never a bare "are you sure".
    const confirm = await screen.findByText(/Count \$900\.00 as/);
    expect(confirm).toBeTruthy();
    expect(screen.getByText(/Money in › Rent|under Money in/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Count it as revenue/ }));

    // ⚠ AND IT SAYS THE MONEY IS IN THE LIVE FIGURES NOW — George asked that outright.
    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByText(/is in your live income/)).toBeTruthy();
    });
    cleanup();
  });
});

// ⚠ RUNS BEFORE THE STANDING-ANSWER TEST BELOW, deliberately: that one turns "any surplus from
// this tenant is revenue" ON for the rest of the file, and no box rings after it.
describe('a roll forward can be taken back', () => {
  it('rolls with one click, says where the money came from, and sends it back', async () => {
    await overpay(5, 1200);
    renderLedger();
    await screen.findByText('Northwind Books');
    const cell = await waitFor(() => {
      const found = [...document.querySelectorAll('.rr-cell.awaiting')]
        .find((el) => /\$1,200\.00 not yet applied/.test(el.getAttribute('aria-label') || ''));
      expect(found).toBeTruthy();
      return found;
    });

    // Roll it to the next month — one click, not a dropdown of twelve.
    fireEvent.doubleClick(cell);
    let panel = await screen.findByRole('dialog');
    fireEvent.click(within(panel).getByRole('button', { name: /^Roll to June$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Roll it to June/ }));

    // ⚠ THE MONTH IT LEFT SAYS SO TOO, which is where the landlord did it and therefore where
    // they look to take it back.
    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByText(/rolled to June/)).toBeTruthy();
    });
    panel = screen.getByRole('dialog');
    // Nothing is left to answer on May — it now holds exactly what it billed.
    expect(within(panel).queryByRole('button', { name: /^Revenue for / })).toBeNull();

    // Step forward to June: the money is there, and it says it did not come from the tenant.
    fireEvent.click(within(panel).getByRole('button', { name: 'Next month' }));
    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByText(/Rolled here from May/)).toBeTruthy();
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Send it back/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Send it back to May/ }));

    // Back to one payment on May, over by 1,200 again — exactly where it started.
    // ⚠ Waited for by its OWN figure: April is still ringing from the first test in this file,
    // so "some cell is awaiting" would have passed before the undo had landed at all.
    await waitFor(() => {
      expect([...document.querySelectorAll('.rr-cell.awaiting')]
        .some((el) => /\$1,200\.00 not yet applied/.test(el.getAttribute('aria-label') || ''))).toBe(true);
    });
    cleanup();
  });
});

// ⚠ THE ANSWER THAT STOPS THE ASKING (George, 2026-08-17: *"there should also be an option to
// just accept the overpayment as revenue — if the user continues to notice it they can just
// change the base rent manually."*). The per-month answer re-asks whenever the figure moves,
// which is right for a one-off and is exactly the nagging a tenant who pays a round number
// every month would produce.
describe('the standing answer settles every month at once', () => {
  it('stops the boxes asking, says the rent may be stale, and can be turned back off', async () => {
    // Three months over — enough to be a pattern rather than a coincidence.
    await overpay(1, 300);
    await overpay(2, 300);
    await overpay(3, 300);
    renderLedger();
    await screen.findByText('Northwind Books');

    // The row says the rent question out loud, on the row where the rent is.
    const chip = await waitFor(() => {
      const found = document.querySelector('.rr-overpaid');
      expect(found).toBeTruthy();
      return found;
    });
    expect(chip.textContent).toMatch(/over \d+ mo/);
    expect(chip.getAttribute('title')).toMatch(/change it on the lease/);

    const before = document.querySelectorAll('.rr-cell.awaiting').length;
    expect(before).toBeGreaterThanOrEqual(3);

    fireEvent.doubleClick(document.querySelector('.rr-cell.awaiting'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/has paid over on/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /^Revenue always$/ }));
    await screen.findByText(/Count anything extra from/);
    // It says it is this year only — a standing answer must not outlive the rent it was about.
    expect(screen.getByText(/this year only/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Count it all as revenue/ }));

    // Every box stops asking, not just the one that was open.
    await waitFor(() => {
      expect(document.querySelectorAll('.rr-cell.awaiting').length).toBe(0);
    });
    // …and it can be undone, or it is a decision a landlord is right to distrust.
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Ask me about these again/ })).toBeTruthy();
    cleanup();
  });
});

describe('a short month can be billed on another one', () => {
  it('offers the mirror of rolling forward, and names both months before writing', async () => {
    renderLedger();
    await screen.findByText('Northwind Books');
    // Northwind Books bills every month and the seed pays none of them, so any untouched
    // month is short. September is clear of the months the tests above wrote to.
    const short = await waitFor(() => {
      const found = [...document.querySelectorAll('.rr-cell')]
        .find((el) => /Sep .* (due|overdue)/.test(el.getAttribute('aria-label') || ''));
      expect(found).toBeTruthy();
      return found;
    });
    fireEvent.doubleClick(short);
    const panel = await screen.findByRole('dialog');
    // The two ways to close a short month sit together: record the money, or bill it elsewhere.
    expect(within(panel).getByRole('button', { name: /Record .* received/ })).toBeTruthy();
    const picker = within(panel).getByText(/Bill .* on another month…/);
    expect(picker.tagName).toBe('OPTION');
    // …and every other month is offered as a destination, this one excluded.
    expect(within(panel).getByRole('option', { name: 'Jan' })).toBeTruthy();
    expect(within(panel).queryByRole('option', { name: 'Sep' })).toBeNull();
    cleanup();
  });
});
