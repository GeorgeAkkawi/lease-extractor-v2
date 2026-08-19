// The Ledger grid's click choreography, pinned against the REAL page and the demo mock.
//
// ⚠ WHY THIS FILE EXISTS (2026-08-18). The one-click/double-click machinery holds ONE
// pending tap, and every entry point used to resolve a prior tap with `cancelTap()` —
// so ticking two months within the 260ms double-click window silently reverted the first
// ✓ and never sent its write, on the grid whose own comment promises "parallel marks
// work". No error, no record: a click that didn't count. The rule now is yield-by-key —
// our own cell's pending tap is a double-click being taken back (cancel); a DIFFERENT
// cell's is a decision already made (flush).
//
// Everything here drives the real LedgerPage against the demo seed. prop-2 (Oak Center)
// is the fixture of choice because its tenants have NO seeded payments, so every due
// month renders as an open, clickable cell.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, within, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LedgerPage from '../LedgerPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { getYearInvoice, listPayments, unmarkMonthPaid } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

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

// The grid, once the roll has landed — found via a tenant the seed always carries.
async function gridRow(name) {
  const cell = await waitFor(() => {
    const el = screen.getByText(name);
    expect(el).toBeTruthy();
    return el;
  });
  return cell.closest('tr');
}

// Let the tap window pass and the scheduled writes run to completion.
async function settleTaps() {
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  vi.useRealTimers();
}

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  // Take back anything a test recorded, so the demo seed is the same for the next one.
  for (const m of [1, 2, 3]) await unmarkMonthPaid('lease-3', Y, m).catch(() => {});
});

describe('the Ledger grid — one click, two cells, no lost writes', () => {
  it('records BOTH months when two cells are clicked inside one tap window', async () => {
    renderLedger();
    const row = await gridRow('Northwind Books');
    const jan = within(row).getByLabelText(/^Jan — /);
    const feb = within(row).getByLabelText(/^Feb — /);

    vi.useFakeTimers();
    fireEvent.click(jan);
    // Inside the 260ms window — under the old cancel-everything rule this click silently
    // reverted January's paint and dropped its write on the floor.
    fireEvent.click(feb);
    await settleTaps();

    await waitFor(async () => {
      const inv = await getYearInvoice('lease-3', Y);
      expect(inv, 'the write must have drafted the year invoice').toBeTruthy();
      const pays = await listPayments(inv.id);
      expect(pays.some((p) => Number(p.period_month) === 1), 'January’s click must survive').toBe(true);
      expect(pays.some((p) => Number(p.period_month) === 2), 'February’s click must survive').toBe(true);
    });
  });

  it('a double-click on the same cell still takes the click back and opens the month', async () => {
    renderLedger();
    const row = await gridRow('Northwind Books');
    const mar = within(row).getByLabelText(/^Mar — /);

    vi.useFakeTimers();
    fireEvent.click(mar);
    fireEvent.click(mar, { detail: 2 }); // the browser's second click — cellClick ignores it
    fireEvent.doubleClick(mar);
    await settleTaps();

    // The pending mark was cancelled, not flushed: nothing was written…
    const inv = await getYearInvoice('lease-3', Y);
    const pays = inv ? await listPayments(inv.id) : [];
    expect(pays.some((p) => Number(p.period_month) === 3)).toBe(false);
    // …and the month panel is open on March.
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /March .* Northwind/ })).toBeTruthy();
    });
  });

  // ⚠ THE WAIT THE DESIGN COMMENT ALWAYS CLAIMED. An open-on-click cell (out of term, lump-
  // covered, abated) used to open the pop-up on the FIRST click — so in a real browser the
  // second click of a double-click landed on the panel's full-screen scrim and closed it
  // again. The single-click open now waits the same 260ms window every other cell action
  // waits, which is what makes a double-click land as ONE open.
  it('an open-on-click cell waits the tap window before opening', async () => {
    renderLedger();
    // Sunrise Yoga starts mid-year, so its January is an out-of-term "—" cell whose single
    // click opens the month.
    const row = await gridRow('Sunrise Yoga Studio');
    const jan = within(row).getByLabelText(/^Jan — before this lease began/);

    vi.useFakeTimers();
    fireEvent.click(jan);
    // Immediately after the click the panel must NOT be open — this is the window whose
    // absence made a double-click flash the panel open and shut.
    expect(screen.queryByRole('dialog')).toBeNull();
    await settleTaps();
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /January .* Sunrise/ })).toBeTruthy();
    });
  });
});
