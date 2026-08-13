// Slice 4a in the DOM — the promise that nothing went missing, on both screens that
// have to make it.
//
// The statement carries one line of each shape at once: a deposit the matcher knows,
// an expense it knows, and a transfer it bins by keyword (IGNORE_KEYWORDS) and nobody
// has decided anything about. That third line is the whole round: before 0076 it
// produced no write and left no trace, so saving reported "1 ignored" and the money
// was simply gone.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import StatementReview from '../StatementReview';
import LedgerPage from '../../pages/LedgerPage';
import { ConfirmProvider } from '../ConfirmDialog';
import { applyStatementImport, undoStatementImport, listUnplacedLines, listDecidedLines } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const parsed = () => ({
  transactions: [
    { date: `${Y}-03-05`, description: 'ACH CREDIT CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 },
    { date: `${Y}-03-09`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 2 },
    { date: `${Y}-03-12`, description: 'ONLINE TRANSFER TO CHECKING 8966', amount: 20154.11, direction: 'out', balance: null, line: 3 },
  ],
  skippedLines: [],
  warnings: [],
});

const renderReview = (onSaved = () => {}, p = parsed()) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="mar.csv" parsed={p} onCancel={() => {}} onSaved={onSaved} />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

// A line no keyword and no tenant recognizes — genuinely homeless, which is what the
// transfer line above stopped being once Slice 4b gave it a destination.
const oneUnknown = () => ({
  transactions: [{ date: `${Y}-03-14`, description: 'MISC PURCHASE 8812', amount: 320.5, direction: 'out', balance: null, line: 1 }],
  skippedLines: [],
  warnings: [],
});

// ConfirmProvider is REQUIRED, not decoration: filing a line asks first since 2026-08-13,
// and useConfirm's default context resolves false — so without the provider every decision
// silently does nothing and a test would "pass" by asserting the line never moved.
const renderLedger = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-1/prop-1/ledger`]}>
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
};

const confirmWith = async (label) => {
  const btn = await screen.findByRole('button', { name: label });
  fireEvent.click(btn);
};

const rowFor = (text) => screen.getByText(text).closest('tr');

beforeEach(() => cleanup());

describe('StatementReview — the completeness statement', () => {
  it('counts a line nobody placed instead of calling it ignored', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());

    // The transfer is unrecognized and untouched → NOT PLACED, said out loud, with the
    // reassurance that it is still on record rather than lost.
    await waitFor(() => expect(screen.getByText(/of 3 lines placed · 1 not placed/)).toBeTruthy());
    expect(screen.getByText(/\$20,154\.11 out/)).toBeTruthy();
    expect(screen.getByText(/Money not yet placed/)).toBeTruthy();

    // The old footer called every unticked row "ignored", which conflated a decision
    // with a blind spot. That wording is gone.
    expect(screen.queryByText(/ignored/)).toBeNull();
  });

  // Money IN nags harder — an unplaced deposit may be rent that should have settled a
  // month, which makes a tenant read short on the grid.
  it('warns harder when the unplaced money came in', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/of 3 lines placed/)).toBeTruthy());
    // Untick the recognized deposit → now a deposit is unplaced.
    const tick = rowFor('ACH CREDIT CITY DENTAL PC').querySelector('input[type=checkbox]');
    fireEvent.click(tick);
    await waitFor(() => expect(screen.getByText(/if any of it is rent/)).toBeTruthy());
    expect(screen.getByText(/\$9,150\.00 in/)).toBeTruthy();
  });

  // Slice 4b — this line USED to be homeless, and this test used to prove the only
  // thing round 6 could offer it: an exclusion with a reason. It now has a real
  // destination, so the same row proves the better outcome. A transfer needs no tick
  // (it writes nothing but itself) — the PICK is the whole decision, exactly as an
  // ignore reason is.
  it('places a transfer on the pick alone, with no tick and no exclusion', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/of 3 lines placed/)).toBeTruthy());

    const transferRow = rowFor('ONLINE TRANSFER TO CHECKING 8966');
    // The matcher already SUGGESTS transfer, so the dropdown reads "Transfer" while
    // the line is still unplaced — re-picking the same value changes nothing. The
    // confirm button is the only thing that can turn a guess into a decision.
    fireEvent.click(within(transferRow).getByText('Confirm transfer'));

    await waitFor(() => expect(document.body.textContent).toContain('3 of 3 lines placed'));
    // Recorded, NOT excluded — a transfer is real money movement that happens to be
    // neither income nor expense, and calling it "left out" would be a lie.
    expect(document.body.textContent).not.toContain('left out on purpose');
    expect(document.body.textContent).not.toContain('not placed');
    expect(document.body.textContent).not.toContain('Money not yet placed');
  });

  // Round 6's guarantee, kept: a line with no home at all can still be answered.
  it('still lets a genuinely unrecognized line be left out, with a reason', async () => {
    renderReview(() => {}, oneUnknown());
    await waitFor(() => expect(screen.getByText(/of 1 line placed/)).toBeTruthy());

    const row = rowFor('MISC PURCHASE 8812');
    expect(within(row).getByText('Leave it out…')).toBeTruthy();
    fireEvent.change(within(row).getByTitle(/Why this line is being left out/), { target: { value: 'personal' } });

    await waitFor(() => expect(within(row).getByText('Why leave it out? (optional)')).toBeTruthy());
    expect(document.body.textContent).toContain('1 left out on purpose');
    expect(document.body.textContent).not.toContain('not placed');
  });

  it('records every line on save, whatever was decided about each', async () => {
    let saved = null;
    renderReview((res) => { saved = res; });
    await waitFor(() => expect(screen.getByText(/of 3 lines placed/)).toBeTruthy());
    fireEvent.click(screen.getByText('Save to ledger'));
    await waitFor(() => expect(saved).toBeTruthy());

    // The row count IS the line count — the guarantee, end to end through the real
    // save path rather than the pure helper.
    expect(saved.summary.completeness.total).toBe(3);
    expect(saved.summary.completeness.unplaced).toBe(1);
    expect(saved.summary.completeness.unplacedOut).toBe(20154.11);

    const open = await listUnplacedLines('prop-1', Y);
    expect(open).toHaveLength(1);
    expect(open[0].description).toContain('TRANSFER');
    await undoStatementImport(saved.import);
  });
});

describe('LedgerPage — money not yet placed', () => {
  it('lists the unplaced line and settles it with a reason', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'mar.csv',
      entries: [{ type: 'cam', property_id: 'prop-1', year: Y, amount: 450, date: `${Y}-03-09`, label: 'Landscaping', billable: true, hash: 'h-cam' }],
      lines: [
        { hash: 'h-cam', year: Y, date: `${Y}-03-09`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', disposition: 'expense' },
        { hash: 'h-draw', year: Y, date: `${Y}-03-12`, description: 'ONLINE TRANSFER TO CHECKING 8966', amount: 20154.11, direction: 'out', disposition: 'unclassified' },
      ],
    });

    renderLedger();
    await waitFor(() => expect(screen.getByText(/Money not yet placed — 1 line/)).toBeTruthy());
    expect(screen.getByText('ONLINE TRANSFER TO CHECKING 8966')).toBeTruthy();
    expect(screen.getByText(/−\$20,154\.11/)).toBeTruthy();

    // ⚠ It ASKS FIRST (2026-08-13). George picked "transfer between my own accounts" by
    // accident on a one-click select and the line was gone with no way back.
    fireEvent.change(screen.getByTitle(/Leave this line out of the ledger/), { target: { value: 'transfer' } });
    expect(await screen.findByText(/Leave this line out of the ledger\?/)).toBeTruthy();
    // The dialog answers the question he actually asked — what happens to the money.
    expect(screen.getByText(/appears in no total on any page or export/)).toBeTruthy();
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(1); // nothing written yet

    await confirmWith('Leave it out');
    await waitFor(() => expect(screen.queryByText(/Money not yet placed/)).toBeNull());
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(0);

    // …and it did not vanish. It is on record, named, under Decided — the read path 0076
    // promised and never built.
    const decided = await listDecidedLines('prop-1', Y);
    expect(decided.map((d) => d.disposition).sort()).toEqual(['expense', 'ignored']);
    expect(decided.find((d) => d.disposition === 'ignored').ignore_reason).toBe('transfer');
    await waitFor(() => expect(screen.getByText(/Decided — 2 lines/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Decided — 2 lines/));
    const row = await waitFor(() => rowFor('ONLINE TRANSFER TO CHECKING 8966'));
    expect(within(row).getByText(/Deliberately left out/)).toBeTruthy();
    expect(within(row).getByText(/transfer between my own accounts/i)).toBeTruthy();

    // Put it back: reversible because being left out wrote no money at all.
    fireEvent.click(within(row).getByRole('button', { name: /Put it back/ }));
    await confirmWith('Put it back');
    await waitFor(() => expect(screen.getByText(/Money not yet placed — 1 line/)).toBeTruthy());
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(1);
    await undoStatementImport(res.import);
  });

  // ⚠ The rule that keeps a dollar from being counted twice: a PLACED line wrote a real
  // other_income / not-billed expense / deposit row, and setLineDisposition never touches
  // money — so offering Undo here would orphan that row and free the line to be placed
  // again. It says "recorded" and points at where the figure lives instead.
  it('offers no undo on a line that actually wrote something', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'apr.csv',
      entries: [{ type: 'cam', property_id: 'prop-1', year: Y, amount: 450, date: `${Y}-04-09`, label: 'Landscaping', billable: true, hash: 'h-cam2' }],
      lines: [{ hash: 'h-cam2', year: Y, date: `${Y}-04-09`, description: 'GREENLEAF LANDSCAPING INV 91', amount: 450, direction: 'out', disposition: 'expense' }],
    });
    renderLedger();
    await waitFor(() => expect(screen.getByText(/Decided — 1 line/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Decided — 1 line/));
    const row = await waitFor(() => rowFor('GREENLEAF LANDSCAPING INV 91'));
    expect(within(row).queryByRole('button', { name: /Put it back/ })).toBeNull();
    expect(within(row).getByText('recorded')).toBeTruthy();
    await undoStatementImport(res.import);
  });

  it('says nothing when every line is placed', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'clean.csv',
      entries: [{ type: 'cam', property_id: 'prop-1', year: Y, amount: 450, date: `${Y}-03-09`, label: 'Landscaping', billable: true, hash: 'h-cam' }],
      lines: [{ hash: 'h-cam', year: Y, date: `${Y}-03-09`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', disposition: 'expense' }],
    });
    renderLedger();
    await waitFor(() => expect(screen.getByText(/Rent Ledger|Collected/i)).toBeTruthy());
    expect(screen.queryByText(/Money not yet placed/)).toBeNull();
    await undoStatementImport(res.import);
  });
});
