// The per-tenant breakdown's newer columns (this batch): the Total column
// (base + CAM & tax + roof) and the carried-over-estimate note. Mounts the REAL
// TenantShareTable against a FRESH demo store, so it's independent of the reconcile
// flow's shared-state tests in camReconciliation.test.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { getLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TenantShareTable propertyId="prop-1" year={Y} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => cleanup());

describe('per-tenant breakdown — Total column + carried-over note', () => {
  it('shows a Total = base + CAM & tax + roof for each tenant', async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    // Bright Coffee: base 60,000 + est CAM&tax 16,500 + est roof 1,500 = 78,000.
    expect(screen.getByText('$78,000.00')).toBeTruthy();
    // City Dental (no estimate): base 84,000 + actual share 25,800 (0.6 × 43,000) = 109,800.
    expect(screen.getByText('$109,800.00')).toBeTruthy();
    // The Total header is present.
    expect(screen.getAllByText('Total').length).toBeGreaterThan(0);
  });

  it('flags a carried-over estimate and clears it once re-saved', async () => {
    // Seed: Bright Coffee's estimate was confirmed last year (est_confirmed_year = Y-1),
    // so for the current year it reads as carried over.
    renderTable();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(screen.getByText(/Estimates carried over from last year/)).toBeTruthy();
    expect(screen.getByText(/carried over — last year/)).toBeTruthy();
    // Re-save the estimate → stamps est_confirmed_year = this year → the note clears.
    fireEvent.click(screen.getByText('$16,500.00'));
    fireEvent.change(screen.getByLabelText('CAM & tax $/SF/yr'), { target: { value: '8.25' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/Estimates carried over from last year/)).toBeNull());
    const lease = await getLease('lease-1');
    expect(lease.est_confirmed_year).toBe(Y);
  });
});
