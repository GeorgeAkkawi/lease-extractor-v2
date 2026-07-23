// Render smoke test for the finances per-tenant table's estimated-vs-actual view
// (0060): the Estimated column with its inline editor, the live Difference, and the
// Reconcile action — instant (no confirm popup), quiet muted outcome line, and the
// ↩ Undo that fully un-reconciles. Mounts the REAL TenantShareTable against the
// demo mock (DEMO mode forced by the test env) so a render crash or missing field
// surfaces here.
//
// Demo seed: Bright Coffee has typed estimates and a saved ANNUAL invoice (inv-1)
// vs an actual share of 18,800 → live "+$800 / tenant owes".
// City Dental has no estimates → "＋ set estimate" / billing actuals.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { listInvoices, getReconciliation, getLease, updateLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // MemoryRouter: a harmless routing context for the table (it renders no links now).
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TenantShareTable propertyId="prop-1" year={Y} />
      </QueryClientProvider>
    </MemoryRouter>
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
    // The Invoice button is gone from the ledger rows (George: the reconcile is what
    // matters at year end) — exact match, so lowercase "invoice" copy doesn't collide.
    expect(screen.queryByText('Invoice')).toBeNull();
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

  it('Reconcile settles the year instantly (no confirm popup): quiet outcome line + Undo', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const buttons = screen.getAllByText('⚖ Reconcile');
    fireEvent.click(buttons[0]); // rows render in seed order — Bright Coffee first
    // The outcome is a quiet muted line, not a colored badge — and no window.confirm
    // stood in the way (nothing mocked here; a popup would throw in jsdom).
    await waitFor(() => expect(screen.getByText('reconciled — owed $800.00 · invoiced')).toBeTruthy());
    // Statement + the persistent Undo appear with the outcome; the shortfall is a real invoice.
    expect(screen.getByText('✉ Statement')).toBeTruthy();
    expect(screen.getByRole('button', { name: '↩ Undo' })).toBeTruthy();
    const recon = await getReconciliation('lease-1', Y);
    expect(recon.direction).toBe('tenant_owes');
    const invoices = await listInvoices('lease-1');
    expect(invoices.find((i) => i.kind === 'reconciliation')?.total_amount).toBe(800);
  });

  it('↩ Undo un-reconciles: record removed, invoice voided, and the year can be redone', async () => {
    // lease-1 is reconciled from the previous test — the row shows the quiet outcome.
    renderTable();
    await waitFor(() => expect(screen.getByText('reconciled — owed $800.00 · invoiced')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '↩ Undo' }));
    // The year reopens: ⚖ Reconcile returns, the record is gone, the invoice is void.
    await waitFor(() => expect(screen.getAllByText('⚖ Reconcile').length).toBeGreaterThan(0));
    expect(await getReconciliation('lease-1', Y)).toBeNull();
    let reconInvs = (await listInvoices('lease-1')).filter((i) => i.kind === 'reconciliation');
    expect(reconInvs).toHaveLength(1);
    expect(reconInvs[0].display_status).toBe('void');
    // Re-reconciling works cleanly (the void freed the unique slot) — then undo once
    // more so later tests see an un-reconciled row.
    fireEvent.click(screen.getAllByText('⚖ Reconcile')[0]);
    await waitFor(() => expect(screen.getByText('reconciled — owed $800.00 · invoiced')).toBeTruthy());
    reconInvs = (await listInvoices('lease-1')).filter((i) => i.kind === 'reconciliation');
    expect(reconInvs.filter((i) => i.display_status !== 'void')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '↩ Undo' }));
    await waitFor(() => expect(screen.getAllByText('⚖ Reconcile').length).toBeGreaterThan(0));
    expect(await getReconciliation('lease-1', Y)).toBeNull();
  });

  it('with no estimates set, the Estimated total + Difference stay dormant (no phantom total)', async () => {
    // prop-2 / Northwind has no typed estimate — the exact situation that used to
    // sum each tenant's actual-share fallback under "Estimated" and print a large
    // phantom total. It must now read — and offer no reconcile.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <TenantShareTable propertyId="prop-2" year={Y} />
        </QueryClientProvider>
      </MemoryRouter>
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

  it('saving a combined $/SF rate stores it as est_cam with est_tax zeroed — and Undo restores the old values', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('$16,500.00')).toBeTruthy());
    fireEvent.click(screen.getByText('$16,500.00'));
    // 8.50 $/SF × 2,000 SF = $17,000/yr combined CAM & tax → the Estimated cell reads $17,000.
    fireEvent.change(screen.getByLabelText('CAM & tax $/SF/yr'), { target: { value: '8.5' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('$17,000.00')).toBeTruthy());
    let lease = await getLease('lease-1');
    expect(lease.est_cam_annual).toBe(17000); // whole combined figure
    expect(lease.est_tax_annual).toBe(0); // tax portion zeroed so cam + tax = the entry
    // The quiet post-save strip offers one-click Undo — it restores what was stored
    // before the save (the seed's split 6,500 / 10,000), not a merged re-entry.
    expect(screen.getByText('estimate saved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '↩ Undo' }));
    await waitFor(() => expect(screen.getByText('$16,500.00')).toBeTruthy());
    lease = await getLease('lease-1');
    expect(lease.est_cam_annual).toBe(6500);
    expect(lease.est_tax_annual).toBe(10000);
  });

  it('shows the vacant space\'s unbilled CAM & tax share, reconciling to the entry total', async () => {
    // The demo building is fully leased (5,000 of 5,000 SF) → no vacancy row.
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(screen.queryByText('Vacant space')).toBeNull();
    cleanup();
    // Shrink Bright Coffee to 1,500 SF → 500 SF vacant. Taxes 25,000 + CAM 18,000
    // = 43,000 entered; the vacant slice = 43,000 × 500/5,000 = 4,300 at $8.60/SF,
    // and tenants (12,900 + 25,800) + 4,300 tie back to the 43,000 entered.
    await updateLease('lease-1', { square_footage: 1500 });
    renderTable();
    await waitFor(() => expect(screen.getByText('Vacant space')).toBeTruthy());
    expect(screen.getByText(/500 SF · 10\.0% of the building — billed to no one/)).toBeTruthy();
    expect(screen.getByText('$4,300.00')).toBeTruthy();
    // The vacant row's $/SF equals every pro-rata tenant's rate (that's the point),
    // now rendered bold (.sf-rate) — the text content is unchanged.
    expect(screen.getAllByText(/\$8\.60\/SF/).length).toBeGreaterThanOrEqual(3);
    expect(document.querySelectorAll('.sf-rate').length).toBeGreaterThanOrEqual(3);
    // The totals actual sub now stacks the reconciliation on two lines (wraps instead
    // of overflowing into the Roof column).
    const totalsSub = screen.getByText(/\+ \$4,300\.00 vacant/);
    expect(totalsSub.textContent).toContain('= $43,000.00 entered');
    await updateLease('lease-1', { square_footage: 2000 });
  });
});
