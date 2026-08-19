// The statement review's YEAR and DECISION rules, pinned against the real component and
// the demo mock (2026-08-19).
//
// ⚠ WHY THIS FILE EXISTS. Three faults, all in the seam between "which year is on screen"
// and "which year this money belongs to", plus the one that decided a statement could be
// saved at all:
//
//   1. The "For month" tag named a month and nothing else. A bank cycle that straddles a
//      year end (Dec 20 – Jan 19 is ordinary) meant retagging a January-dated cheque to
//      "Dec" booked December of the JANUARY year — eleven months into the future — while
//      the December it actually paid stayed open and fired `missing_payment`.
//   2. Save was enabled by rent-or-expense only. A statement whose one actionable line was
//      a late fee, an owner draw or a deposit could never be saved AT ALL, and an
//      all-ignored statement wrote no audit lines while the note beside the disabled
//      button promised "every line this statement showed is on record".
//   3. A tagged payment settles its own month and never rolls forward — so money tagged to
//      a month that bills nothing settles nothing. That is the one case
//      `depositProjectionDelta` returns null for, i.e. every warning stood down at exactly
//      the moment 100% of the deposit was misplaced.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const PRIOR = Y - 1;

const parsedOf = (transactions) => ({ transactions, skippedLines: [], warnings: [] });

function renderReview(parsed, { propertyId = 'prop-1', year = Y } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview
          propertyId={propertyId}
          year={year}
          fileName="stmt.csv"
          parsed={parsed}
          onCancel={() => {}}
          onSaved={() => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const saveButton = () => screen.getByRole('button', { name: /Save to ledger/ });
// The row's own "what is this line" picker — the first select that offers the leases
// (the page's property chooser is a combobox too, and comes first in the DOM).
const rowPicker = () => screen.getAllByRole('combobox')
  .find((c) => [...c.options].some((o) => o.value.startsWith('lease:')));

beforeEach(() => cleanup());

describe('StatementReview — a statement that crosses a year end', () => {
  // A December-to-January cycle: the tenant deposit sits in the PRIOR year, the page is
  // showing the current one.
  const straddling = () => parsedOf([
    { date: `${PRIOR}-12-28`, description: 'CITY DENTAL GROUP RENT', amount: 3200, direction: 'in', balance: null, line: 1 },
    { date: `${PRIOR}-12-29`, description: 'UNKNOWN PAYER QZ001', amount: 90, direction: 'in', balance: null, line: 2 },
    { date: `${Y}-01-03`, description: 'UNKNOWN PAYER QZ002', amount: 110, direction: 'in', balance: null, line: 3 },
  ]);

  it('names the YEAR on every month option, so a retag cannot book eleven months away', async () => {
    renderReview(straddling());
    await waitFor(() => expect(screen.getByText('CITY DENTAL GROUP RENT')).toBeTruthy());

    // Before the fix these read "Dec" and "Jan" — the same twelve labels whichever year
    // the line belonged to, which is exactly what made the tag ambiguous.
    expect(screen.getAllByRole('option', { name: `Dec ${PRIOR}` }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: `Jan ${Y}` }).length).toBeGreaterThan(0);
    // …and the year the line already belongs to is what the box shows.
    const opt = screen.getAllByRole('option', { name: `Dec ${PRIOR}` })[0];
    expect(opt.selected).toBe(true);
  });

  it('says out loud that the ledger on screen is a different year from these lines', async () => {
    renderReview(straddling());
    await waitFor(() => expect(screen.getByText('CITY DENTAL GROUP RENT')).toBeTruthy());
    // The money still books to its own year; what can be wrong is the advice printed
    // beside it, because every guard is built from the viewed year's roll alone.
    const note = await screen.findByText(new RegExp(`dated ${PRIOR}, but the ledger on screen is ${Y}`));
    expect(note.textContent).toMatch(/worked out against/);
  });

  it('keeps the plain twelve labels on an ordinary single-year statement', async () => {
    renderReview(parsedOf([
      { date: `${Y}-05-02`, description: 'CITY DENTAL GROUP RENT', amount: 3200, direction: 'in', balance: null, line: 1 },
      { date: `${Y}-05-03`, description: 'UNKNOWN PAYER QZ001', amount: 90, direction: 'in', balance: null, line: 2 },
    ]));
    await waitFor(() => expect(screen.getByText('CITY DENTAL GROUP RENT')).toBeTruthy());
    expect(screen.getAllByRole('option', { name: 'May' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option', { name: `May ${Y}` })).toBeNull();
    expect(screen.queryByText(/but the ledger on screen is/)).toBeNull();
  });
});

describe('StatementReview — what makes a statement saveable', () => {
  const oneOddDeposit = () => parsedOf([
    { date: `${Y}-03-05`, description: 'NAPERVILLE PARKING PERMITS', amount: 240, direction: 'in', balance: null, line: 1 },
  ]);

  it('a decision that writes no money is still a decision — Save records it', async () => {
    renderReview(oneOddDeposit());
    await waitFor(() => expect(screen.getByText('NAPERVILLE PARKING PERMITS')).toBeTruthy());
    // Nothing decided yet.
    expect(saveButton().disabled).toBe(true);

    // File it as a transfer — it writes no money, and the disposition IS the record
    // (0076). Before the fix Save stayed disabled here forever, so the line was never
    // written and the completeness note's promise could not be kept.
    fireEvent.change(rowPicker(), { target: { value: 'transfer' } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('a statement whose only money is other income can be saved', async () => {
    renderReview(oneOddDeposit());
    await waitFor(() => expect(screen.getByText('NAPERVILLE PARKING PERMITS')).toBeTruthy());
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(rowPicker(), { target: { value: 'income:parking' } });
    fireEvent.click(screen.getByTitle('Include this line'));
    // Other income writes a real row; it was counted by neither `willPay` nor
    // `willExpense`, so the button stayed dead on a statement that had money to record.
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });
});

describe('StatementReview — a month that bills nothing', () => {
  it('holds back a deposit tagged to a month with nothing due, and says why', async () => {
    // Sunrise Yoga's lease starts mid-year on the demo seed, so its January bills $0 —
    // the shape a final cheque landing just past a lease end takes in real life.
    renderReview(
      parsedOf([
        { date: `${Y}-01-08`, description: 'SUNRISE YOGA STUDIO RENT', amount: 2150, direction: 'in', balance: null, line: 1 },
      ]),
      { propertyId: 'prop-2' }
    );
    await waitFor(() => expect(screen.getByText('SUNRISE YOGA STUDIO RENT')).toBeTruthy());

    const warn = await screen.findByText(/bills this tenant nothing/);
    expect(warn.textContent).toMatch(/lump/);
    // …and it is NOT pre-ticked: a tag settles its own month and never rolls forward, so
    // saving it would park the money where nothing is due while the tenant reads behind.
    expect(screen.getByTitle('Include this line').checked).toBe(false);
  });
});
