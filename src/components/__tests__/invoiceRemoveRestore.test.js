// "Remove invoice" on the lease page, driven through the REAL panel against the demo mock.
//
// ⚠ WHY THIS EXISTS. The button is offered on ANY non-void invoice with no `kind` test — so it
// is offered on the year's ANNUAL invoice, the one the app raises by itself the first time a
// month is ticked on the Ledger. Every ledger read filters void invoices (`getYearInvoice`,
// `getMonthlyRent`, `getPropertyMonthlyRoll`), so confirming it takes every payment recorded
// against that tenant-year off the Rent Ledger grid, the monthly tracker, the Tenant statement
// and the Overview's collected figure. The dialog said "It stops counting toward receivables ·
// You can still see it under 'removed' — this is reversible · Recorded payments stay attached",
// in gold, and the click repainted nothing but the row itself.
//
// Two of those three lines were false: nothing in the app could un-void an invoice, and the
// payments stayed attached to a row no money screen would read again. This pins the three
// things that fixed it — the dialog names the real cost, the restore exists, and the click
// repaints the screens the money left.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import InvoicesPanel from '../InvoicesPanel';
import { ensureInvoice, recordPayment, listInvoices, getMonthlyRent } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderPanel(qc) {
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <InvoicesPanel leaseId="lease-4" />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

describe('removing the year invoice tells the truth and can be undone', () => {
  it('names the payments it hides, repaints the ledger reads, and offers Restore', async () => {
    const inv = await ensureInvoice('lease-4', 'prop-2', Y);
    await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-4', amount: 3000,
      paid_date: `${Y}-08-02`, method: 'check', period_month: 8, source: 'manual',
    });
    // Before: the lease's own monthly tracker can see the cheque.
    expect((await getMonthlyRent('lease-4', Y)).payments.length).toBeGreaterThan(0);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    renderPanel(qc);

    fireEvent.click(await screen.findByRole('button', { name: 'Payments' }));
    // Wait for the payment rows — the confirm is built from them, so clicking before they
    // land would assert the empty-handed wording rather than the one that matters.
    await screen.findByText('check');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove invoice' }));

    // ⚠ THE DIALOG STATES WHAT LEAVES THE SCREEN, in payments and dollars — "Recorded payments
    // stay attached" was true and useless, because they stay attached to a dead row.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/The 1 payment recorded against it/)).toBeTruthy();
    expect(within(dialog).getByText(/\$3,000\.00/)).toBeTruthy();
    expect(within(dialog).getByText(/reads as having paid nothing/)).toBeTruthy();
    // …and it no longer claims to be reversible without saying on what condition.
    expect(within(dialog).queryByText(/this is reversible/)).toBeNull();
    expect(within(dialog).getByText(/put it back from “removed”/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    // The write lands…
    await waitFor(async () => {
      const rows = await listInvoices('lease-4');
      expect(rows.find((r) => r.id === inv.id)?.status).toBe('void');
    });
    // …the ledger reads really do lose the money (which is why the dialog has to say so)…
    expect((await getMonthlyRent('lease-4', Y)).payments.length).toBe(0);
    // …and the screens that just lost it are repainted at the moment of the click, rather than
    // on the next hard refresh. `settlePaymentChange`'s two headline keys.
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys.some((k) => k?.includes('propertyRentRoll'))).toBe(true);
    expect(keys.some((k) => k?.includes('portfolioBasis'))).toBe(true);

    // ⚠ AND THERE IS A WAY BACK, which is the only thing that made "reversible" true.
    fireEvent.click(await screen.findByRole('button', { name: /removed — show/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(async () => {
      const rows = await listInvoices('lease-4');
      expect(rows.find((r) => r.id === inv.id)?.status).not.toBe('void');
    });
    expect((await getMonthlyRent('lease-4', Y)).payments.length).toBe(1);
    cleanup();
  });
});
