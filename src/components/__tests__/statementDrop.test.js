// Dragging a bank statement onto the Ledger, driven through the REAL LedgerPage
// against the demo mock.
//
// George, 2026-07-30: "make the import statements on the ledger able to recieve a
// drag and drop."
//
// The pipeline itself is already pinned by statementImport / statementParse — what
// only a render can prove is that the drop lands: that the panel is genuinely the
// target (not just the button), that a dropped CSV reaches the review screen having
// gone through the same gate the button uses, and that the three ways a drop can be
// wrong are refused with something a person can read.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import LedgerPage from '../../pages/LedgerPage';

// A two-line statement in the shape a bank exports: one rent deposit, one expense.
const CSV = [
  'Date,Description,Amount',
  '03/05/2026,DEPOSIT CITY DENTAL,9150.00',
  '03/09/2026,GREENLEAF LANDSCAPING,-1200.00',
].join('\n');

const file = (name, body = CSV, type = 'text/csv') => {
  const f = new File([body], name, { type });
  // jsdom ships no Blob.text(), which every browser has had since 2019 and which
  // the CSV lane reads the file with. Shimmed so the test exercises the real
  // pipeline instead of the environment's gap.
  if (!f.text) f.text = async () => body;
  return f;
};

// jsdom has no DataTransfer, so the event carries the shape the handler reads:
// `types` (what decides whether this is a file drag at all) and `files`.
const transfer = (files) => ({ types: ['Files'], files, dropEffect: '' });

function renderLedger() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/financials/corp-1/prop-1/ledger']}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// The drop target is the ledger PANEL — the same element the import button sits in.
const panel = async () => {
  renderLedger();
  await screen.findByText('Bright Coffee Co.');
  const el = document.querySelector('.stmt-drop');
  expect(el).toBeTruthy();
  return el;
};

const veil = () => document.querySelector('.stmt-drop-veil');

beforeEach(() => cleanup());

describe('The panel itself takes the drop', () => {
  it('is the panel carrying the import button, not a separate box', async () => {
    // A permanent dashed target would cost height on an already-dense screen; the
    // point is that the whole ledger accepts the file while the button stays put.
    const el = await panel();
    expect(el.classList.contains('panel')).toBe(true);
    expect(el.querySelector('button[title*="drag the file"]')).toBeTruthy();
    // Nothing is drawn until a file is actually over it.
    expect(veil()).toBeNull();
  });

  it('shows the target while a file is over it, and clears when it leaves', async () => {
    const el = await panel();
    fireEvent.dragEnter(el, { dataTransfer: transfer([]) });
    await waitFor(() => expect(veil()).toBeTruthy());
    expect(veil().textContent).toMatch(/Drop to import this statement/);
    // It says what will happen next — nothing is recorded on the drop itself.
    expect(veil().textContent).toMatch(/review before anything is recorded/);

    fireEvent.dragLeave(el, { dataTransfer: transfer([]) });
    await waitFor(() => expect(veil()).toBeNull());
  });

  it('holds steady while the cursor crosses the rows inside it', async () => {
    // dragenter/dragleave fire again for every child, so a boolean would flicker off
    // the moment you moved over a tenant row — the counter is what stops that.
    const el = await panel();
    const row = el.querySelector('table');
    expect(row).toBeTruthy();

    fireEvent.dragEnter(el, { dataTransfer: transfer([]) });
    fireEvent.dragEnter(row, { dataTransfer: transfer([]) });   // entered a child…
    fireEvent.dragLeave(el, { dataTransfer: transfer([]) });    // …so the panel "left"
    await waitFor(() => expect(veil()).toBeTruthy());           // still over it

    fireEvent.dragLeave(row, { dataTransfer: transfer([]) });
    await waitFor(() => expect(veil()).toBeNull());
  });

  it('ignores a drag that is not a file', async () => {
    // Selected text, a link, or one of the app's own draggable rows must leave the
    // panel alone rather than promising to import something.
    const el = await panel();
    fireEvent.dragEnter(el, { dataTransfer: { types: ['text/plain'], files: [] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(veil()).toBeNull();
  });
});

describe('What a dropped statement does', () => {
  it('reads it through the same gate the button uses and opens the review', async () => {
    const el = await panel();
    fireEvent.drop(el, { dataTransfer: transfer([file('march.csv')]) });

    // The host swaps the page for StatementReview, naming the file it read.
    await waitFor(() => expect(screen.getByText(/reviewing march\.csv/)).toBeTruthy(), { timeout: 4000 });
    // …with the statement's own lines on it, classified in and out.
    await waitFor(() => expect(screen.getByText(/DEPOSIT CITY DENTAL/)).toBeTruthy());
    // (More than once — the row also offers to remember the payee.)
    expect(screen.getAllByText(/GREENLEAF LANDSCAPING/).length).toBeGreaterThan(0);
  });

  it('refuses a file that is not a statement, without spending a read on it', async () => {
    // The PDF lane uploads and pays for a transcription before it can fail, so the
    // extension is checked first — the same guard the button gets.
    const el = await panel();
    fireEvent.drop(el, { dataTransfer: transfer([file('lease.docx', 'x', '')]) });

    const msg = await screen.findByText(/isn’t a bank statement/);
    expect(msg.textContent).toMatch(/lease\.docx/);
    expect(msg.textContent).toMatch(/CSV/);
    // Still on the ledger — nothing opened for review.
    expect(screen.queryByText(/reviewing/)).toBeNull();
  });

  it('refuses a handful of files rather than silently reading the first', async () => {
    // Importing one of five would look like all five had been imported.
    const el = await panel();
    fireEvent.drop(el, { dataTransfer: transfer([file('jan.csv'), file('feb.csv'), file('mar.csv')]) });

    const msg = await screen.findByText(/3 files were dropped/);
    expect(msg.textContent).toMatch(/one statement at a time/);
    expect(screen.queryByText(/reviewing/)).toBeNull();
  });

  it('clears the target the moment the file lands', async () => {
    const el = await panel();
    fireEvent.dragEnter(el, { dataTransfer: transfer([file('march.csv')]) });
    await waitFor(() => expect(veil()).toBeTruthy());
    fireEvent.drop(el, { dataTransfer: transfer([file('march.csv')]) });
    // It becomes the reading state, never staying stuck on "Drop to import".
    await waitFor(() => expect(veil()?.textContent || '').not.toMatch(/Drop to import/));
  });
});
