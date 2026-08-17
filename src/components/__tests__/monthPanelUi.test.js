// The month detail panel — mounted through the REAL LedgerPage against the demo mock,
// driven by clicking the actual month box.
//
// ⚠ IT DRIVES THE CELL RATHER THAN ASSERTING ITS MARKUP EXISTS. A test that queried for
// the panel's own elements would pass while the box that is supposed to open it was
// unreachable — the same failure shape as counting a label that renders and can't be
// clicked (2026-08-02). So every case starts at a month box on the grid.
//
// prop-2 (Oak Center) is the OPEN-year property; prop-1 carries a financial_snapshots
// row for the current year, so an adjustment there would refuse.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../ConfirmDialog';
import LedgerPage from '../../pages/LedgerPage';
import TenantStatement from '../TenantStatement';
import {
  updateLease, markMonthPaid, unmarkMonthPaid, listAdjustments, deleteAdjustment, ensureInvoice,
} from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderLedger(propId = 'prop-2') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-2/${propId}/ledger`]}>
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

// January of a full-year lease has always come due, whatever month the suite runs in.
const janCell = () => document.querySelectorAll('.rent-roll tbody tr')[0].querySelectorAll('td')[1].querySelector('.rr-cell');

beforeEach(async () => {
  cleanup();
  await updateLease('lease-3', { est_cam_annual: 12000, est_tax_annual: 0, est_roof_annual: null });
  await ensureInvoice('lease-3', 'prop-2', Y);
});
afterEach(async () => {
  for (const a of await listAdjustments({ leaseId: 'lease-3', year: Y })) await deleteAdjustment(a.id);
  await unmarkMonthPaid('lease-3', Y, 1);
});

describe('the Rent Ledger month panel', () => {
  it('an OPEN month still marks paid in one click — the panel does not steal it', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    const jan = janCell();
    expect(jan.textContent).toBe('—');
    fireEvent.click(jan);
    // It records the month rather than opening a dialog (George's call).
    await waitFor(() => expect(janCell().className).toContain('paid'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a settled month opens, states what was billed vs received, and posts a charge that the box then shows', async () => {
    await markMonthPaid('lease-3', 'prop-2', Y, 1);
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    await waitFor(() => expect(janCell().className).toContain('paid'));

    fireEvent.dblClick(janCell());
    const panel = await screen.findByRole('dialog', { name: /January/ });
    expect(within(panel).getByText('What you billed')).toBeTruthy();
    expect(within(panel).getByText('What came in')).toBeTruthy();
    expect(within(panel).getByText('Settled')).toBeTruthy();

    // Post a +$400 CAM & tax correction through the real form.
    fireEvent.change(within(panel).getByLabelText('Kind'), { target: { value: 'camtax' } });
    fireEvent.change(within(panel).getByLabelText('Amount'), { target: { value: '400' } });
    fireEvent.change(within(panel).getByLabelText('Note (optional)'), { target: { value: 'Snow removal ran high' } });
    fireEvent.click(within(panel).getByText('Post charge'));

    // The month now owes $400 more than what came in — and the BOX says so: it goes gold
    // and wears the corner mark. The amount and the note ride the hover card (2026-08-17),
    // which is the only place the note has ever been readable from the grid.
    await waitFor(() => expect(document.querySelector('.rent-roll .rr-cell.has-adj')).toBeTruthy());
    expect(janCell().className).toContain('off');
    fireEvent.mouseEnter(janCell());
    const card = document.querySelector('.tipcard');
    expect(card.textContent).toContain('+$400.00');
    expect(card.textContent).toContain('Snow removal ran high');
    fireEvent.mouseLeave(janCell());
    const stored = await listAdjustments({ leaseId: 'lease-3', year: Y });
    expect(stored).toHaveLength(1);
    expect(Number(stored[0].amount)).toBe(400);
    expect(stored[0].memo).toBe('Snow removal ran high');
  });

  it('the panel offers to record the difference, and doing so settles the month', async () => {
    await markMonthPaid('lease-3', 'prop-2', Y, 1);
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    await waitFor(() => expect(janCell().className).toContain('paid'));
    fireEvent.dblClick(janCell());
    let panel = await screen.findByRole('dialog', { name: /January/ });
    fireEvent.change(within(panel).getByLabelText('Kind'), { target: { value: 'fee' } });
    fireEvent.change(within(panel).getByLabelText('Amount'), { target: { value: '250' } });
    fireEvent.click(within(panel).getByText('Post charge'));

    panel = await screen.findByRole('dialog', { name: /January/ });
    await waitFor(() => expect(within(panel).getByText('Still owed')).toBeTruthy());
    expect(within(panel).getByText('$250.00')).toBeTruthy();
    fireEvent.click(within(panel).getByText('Record $250.00 received'));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /January/ })).getByText('Settled')).toBeTruthy());
  });

  it('a late fee is locked to "charge" — the direction picker cannot flip it', async () => {
    await markMonthPaid('lease-3', 'prop-2', Y, 1);
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    await waitFor(() => expect(janCell().className).toContain('paid'));
    fireEvent.dblClick(janCell());
    const panel = await screen.findByRole('dialog', { name: /January/ });
    fireEvent.change(within(panel).getByLabelText('Kind'), { target: { value: 'fee' } });
    const picker = within(panel).getByLabelText('Charge or credit');
    expect(picker.disabled).toBe(true);
    expect(picker.value).toBe('charge');
  });

  it('the tenant statement reads the same charge back as a dated entry with a running balance', async () => {
    await markMonthPaid('lease-3', 'prop-2', Y, 1);
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    await waitFor(() => expect(janCell().className).toContain('paid'));
    fireEvent.dblClick(janCell());
    const panel = await screen.findByRole('dialog', { name: /January/ });
    fireEvent.change(within(panel).getByLabelText('Kind'), { target: { value: 'fee' } });
    fireEvent.change(within(panel).getByLabelText('Amount'), { target: { value: '75' } });
    fireEvent.change(within(panel).getByLabelText('Note (optional)'), { target: { value: 'Late fee' } });
    fireEvent.click(within(panel).getByText('Post charge'));
    await waitFor(async () => expect(await listAdjustments({ leaseId: 'lease-3', year: Y })).toHaveLength(1));

    cleanup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TenantStatement leaseId="lease-3" year={Y} tenantName="Northwind Books" />
      </QueryClientProvider>
    );
    const toggle = await screen.findByText(/Tenant statement/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('Late fee / other charge — January')).toBeTruthy());
    // The rent charge, the payment that settled it, and the fee — with the fee left owing.
    expect(screen.getByText('Rent — January')).toBeTruthy();
    expect(screen.getByText(/Payment received/)).toBeTruthy();
    expect(screen.getByText('Balance owed')).toBeTruthy();
  });

  // ⚠ THE DIALOG CONTRADICTED THE LINE DIRECTLY ABOVE IT, on every credit there has ever
  // been. "This year's invoice is re-issued at the lower total" was hardcoded — removing a
  // CREDIT raises the invoice, and the implication above it had the arithmetic right all
  // along. A confirm that states the opposite of what will happen is worse than no confirm.
  it('says the invoice goes HIGHER when the entry being removed is a credit', async () => {
    await markMonthPaid('lease-3', 'prop-2', Y, 1);
    renderLedger();
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    await waitFor(() => expect(janCell().className).toContain('paid'));
    fireEvent.dblClick(janCell());
    let panel = await screen.findByRole('dialog', { name: /January/ });

    // A concession — the one kind that is locked to "credit".
    fireEvent.change(within(panel).getByLabelText('Kind'), { target: { value: 'credit' } });
    fireEvent.change(within(panel).getByLabelText('Amount'), { target: { value: '300' } });
    fireEvent.click(within(panel).getByText('Post credit'));
    await waitFor(() => expect(document.querySelector('.rent-roll .rr-cell.adj-credit')).toBeTruthy());

    panel = await screen.findByRole('dialog', { name: /January/ });
    fireEvent.click(within(panel).getByLabelText('Remove this adjustment'));
    const confirm = await screen.findByText('Remove this adjustment?');
    const box = confirm.closest('.modal') || document.body;
    expect(within(box).getByText(/re-issued at the HIGHER total/)).toBeTruthy();
    expect(within(box).queryByText(/re-issued at the lower total/)).toBeNull();
  });

  it('a GROSS tenant is not offered the CAM & tax correction', async () => {
    await updateLease('lease-3', { lease_type: 'gross' });
    try {
      await markMonthPaid('lease-3', 'prop-2', Y, 1);
      renderLedger();
      await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
      await waitFor(() => expect(janCell().className).toContain('paid'));
      fireEvent.dblClick(janCell());
      const panel = await screen.findByRole('dialog', { name: /January/ });
      const options = Array.from(within(panel).getByLabelText('Kind').options).map((o) => o.value);
      expect(options).not.toContain('camtax');
      expect(options).toEqual(['base', 'fee', 'credit']);
    } finally {
      await updateLease('lease-3', { lease_type: null });
    }
  });
});
