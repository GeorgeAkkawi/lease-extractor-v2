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
import { applyStatementImport, undoStatementImport, listUnplacedLines } from '../../lib/api';
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

const renderReview = (onSaved = () => {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="mar.csv" parsed={parsed()} onCancel={() => {}} onSaved={onSaved} />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const renderLedger = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-1/prop-1/ledger`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
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

  it('lets a deliberate exclusion say why, and counts it as accounted for', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/of 3 lines placed/)).toBeTruthy());

    const transferRow = rowFor('ONLINE TRANSFER TO CHECKING 8966');
    // The matcher binned this by keyword, which is a guess — so it reads as an OFFER
    // to leave it out, not as a decision already taken on the landlord's behalf.
    expect(within(transferRow).getByText('Leave it out…')).toBeTruthy();
    expect(within(transferRow).queryByText('Why leave it out? (optional)')).toBeNull();

    // Picking the reason IS the decision — one click turns the guess into a record.
    fireEvent.change(within(transferRow).getByTitle(/Why this line is being left out/), { target: { value: 'transfer' } });
    await waitFor(() => expect(within(transferRow).getByText('Why leave it out? (optional)')).toBeTruthy());

    // Now every line is accounted for and the unplaced nag is gone. (The footer wraps
    // its counts in <strong>, so this reads the assembled text rather than one node.)
    await waitFor(() => expect(document.body.textContent).toContain('1 left out on purpose'));
    expect(document.body.textContent).not.toContain('not placed');
    expect(document.body.textContent).not.toContain('Money not yet placed');
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

    // Answering the nag from here records the decision without re-importing anything.
    fireEvent.change(screen.getByTitle(/Leave this line out of the ledger for good/), { target: { value: 'transfer' } });
    await waitFor(() => expect(screen.queryByText(/Money not yet placed/)).toBeNull());

    const stillThere = await listUnplacedLines('prop-1', Y);
    expect(stillThere).toHaveLength(0);
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
