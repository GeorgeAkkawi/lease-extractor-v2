// Render smoke test for the finances per-tenant table's estimated-vs-actual view
// (0060): the Estimated column with its inline editor, the live Difference, and the
// Reconcile action. Mounts the REAL TenantShareTable against the demo mock (DEMO
// mode forced by the test env) so a render crash or missing field surfaces here.
//
// Demo seed: Bright Coffee has typed estimates and a saved ANNUAL invoice (inv-1,
// billed snapshot 18,100) vs an actual share of 18,800 → live "+$700 / tenant owes".
// City Dental has no estimates → "＋ set estimate" / billing actuals.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { listInvoices, getReconciliation, getLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TenantShareTable propertyId="prop-1" year={Y} />
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('TenantShareTable — estimated vs actual + reconcile', () => {
  it('shows the estimate (with tag), the live difference, and the set-estimate affordance', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    // Bright Coffee's typed estimates: 6,500 CAM + 10,000 tax with the est. tag —
    // and, like the actual columns, the per-SF figure (16,500 / 2,000 SF = $8.25/SF).
    expect(screen.getByText('$16,500.00')).toBeTruthy();
    expect(screen.getByText(/\$8\.25\/SF/)).toBeTruthy();
    expect(screen.getAllByText(/est\./).length).toBeGreaterThan(0);
    // Live difference off the CURRENT estimate: 18,800 actual − 18,000 estimate = +800
    // (shown on Bright Coffee's row and, since it's the only tenant with an estimate,
    // mirrored in the Totals row).
    expect(screen.getAllByText('+$800.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('tenant owes').length).toBeGreaterThan(0);
    // City Dental (no estimates) invites entry, shows it's billing actuals, and its
    // Difference stays dormant (—) — no phantom estimate/difference without one set.
    expect(screen.getByText('＋ set estimate')).toBeTruthy();
    expect(screen.getByText('billing actuals')).toBeTruthy();
  });

  it('clicking the estimate opens the inline editor — one combined CAM & tax $/SF input', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('$16,500.00')).toBeTruthy());
    fireEvent.click(screen.getByText('$16,500.00'));
    expect(screen.getByText('CAM & tax $/SF/yr')).toBeTruthy();
    expect(screen.queryByText('Tax $/SF/yr')).toBeNull(); // merged into the single CAM & tax field
    expect(screen.getByText('Roof $/SF/yr')).toBeTruthy(); // Bright Coffee is roof-responsible
    // The one CAM & tax input carries the combined estimate as a rate:
    // (6,500 + 10,000) / 2,000 SF = 8.25; the preview shows 18,000 incl. roof 1,500.
    expect(screen.getByLabelText('CAM & tax $/SF/yr').value).toBe('8.25');
    expect(screen.getByText(/= \$18,000\.00\/yr/)).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('Reconcile settles the year: recon invoice lands in receivables, row shows the outcome', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const buttons = screen.getAllByText('⚖ Reconcile');
    fireEvent.click(buttons[0]); // rows render in seed order — Bright Coffee first
    await waitFor(() => expect(screen.getByText(/Owed \$800\.00/)).toBeTruthy());
    // The statement button appears with the outcome; the shortfall is a real invoice.
    expect(screen.getByText('✉ Statement')).toBeTruthy();
    const recon = await getReconciliation('lease-1', Y);
    expect(recon.direction).toBe('tenant_owes');
    const invoices = await listInvoices('lease-1');
    expect(invoices.find((i) => i.kind === 'reconciliation')?.total_amount).toBe(800);
    vi.restoreAllMocks();
  });

  it('with no estimates set, the Estimated total + Difference stay dormant (no phantom total)', async () => {
    // prop-2 / Northwind has no typed estimate — the exact situation that used to
    // sum each tenant's actual-share fallback under "Estimated" and print a large
    // phantom total. It must now read — and offer no reconcile.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TenantShareTable propertyId="prop-2" year={Y} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText('Northwind Books')).toBeTruthy());
    // prop-2 has two estimate-free tenants (Northwind + the mid-year Sunrise Yoga seed).
    expect(screen.getAllByText('＋ set estimate').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('billing actuals').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('⚖ Reconcile')).toBeNull(); // nothing to true up
    // Totals "Estimated" + "Difference" read — (an em dash), never a summed fallback.
    // (The totals live in the ledger's closing band since the no-sideways-scroll redesign.)
    const totalsRow = screen.getByText('Totals').closest('.ledger-totals');
    expect(within(totalsRow).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('saving a combined $/SF rate stores it as est_cam with est_tax zeroed', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('$16,500.00')).toBeTruthy());
    fireEvent.click(screen.getByText('$16,500.00'));
    // 8.50 $/SF × 2,000 SF = $17,000/yr combined CAM & tax → the Estimated cell reads $17,000.
    fireEvent.change(screen.getByLabelText('CAM & tax $/SF/yr'), { target: { value: '8.5' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('$17,000.00')).toBeTruthy());
    const lease = await getLease('lease-1');
    expect(lease.est_cam_annual).toBe(17000); // whole combined figure
    expect(lease.est_tax_annual).toBe(0); // tax portion zeroed so cam + tax = the entry
  });
});
