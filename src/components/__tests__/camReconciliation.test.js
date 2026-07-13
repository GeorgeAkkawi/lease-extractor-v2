// Render smoke test for the finances per-tenant table's estimated-vs-actual view
// (0060): the Estimated column with its inline editor, the live Difference, and the
// Reconcile action. Mounts the REAL TenantShareTable against the demo mock (DEMO
// mode forced by the test env) so a render crash or missing field surfaces here.
//
// Demo seed: Bright Coffee has typed estimates and a saved ANNUAL invoice (inv-1,
// billed snapshot 18,100) vs an actual share of 18,800 → live "+$700 / tenant owes".
// City Dental has no estimates → "＋ set estimate" / billing actuals.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { listInvoices, getReconciliation } from '../../lib/api';
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
    // Bright Coffee's typed estimates: 6,500 CAM + 10,000 tax with the est. tag.
    expect(screen.getByText('$16,500.00')).toBeTruthy();
    expect(screen.getAllByText(/est\./).length).toBeGreaterThan(0);
    // Live difference off the inv-1 billed snapshot: 18,800 actual − 18,100 = +700.
    // (City Dental's row also reads "tenant owes" — its seeded invoice under-bills
    // the actual share — so match all.)
    expect(screen.getByText('+$700.00')).toBeTruthy();
    expect(screen.getAllByText('tenant owes').length).toBeGreaterThan(0);
    // City Dental (no estimates) invites entry and shows it's billing actuals.
    expect(screen.getByText('＋ set estimate')).toBeTruthy();
    expect(screen.getByText('billing actuals')).toBeTruthy();
  });

  it('clicking the estimate opens the inline editor with per-component inputs', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('$16,500.00')).toBeTruthy());
    fireEvent.click(screen.getByText('$16,500.00'));
    expect(screen.getByText('CAM $/yr')).toBeTruthy();
    expect(screen.getByText('Tax $/yr')).toBeTruthy();
    expect(screen.getByText('Roof $/yr')).toBeTruthy(); // Bright Coffee is roof-responsible
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('Reconcile settles the year: recon invoice lands in receivables, row shows the outcome', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    const buttons = screen.getAllByText('⚖ Reconcile');
    fireEvent.click(buttons[0]); // rows render in seed order — Bright Coffee first
    await waitFor(() => expect(screen.getByText(/Owed \$700\.00/)).toBeTruthy());
    // The statement button appears with the outcome; the shortfall is a real invoice.
    expect(screen.getByText('✉ Statement')).toBeTruthy();
    const recon = await getReconciliation('lease-1', Y);
    expect(recon.direction).toBe('tenant_owes');
    const invoices = await listInvoices('lease-1');
    expect(invoices.find((i) => i.kind === 'reconciliation')?.total_amount).toBe(700);
    vi.restoreAllMocks();
  });
});
