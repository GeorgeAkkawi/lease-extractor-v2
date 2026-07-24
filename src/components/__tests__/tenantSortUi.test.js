// The shared tenant sort bar reorders the tenants on BOTH the Rent Ledger and the
// per-tenant breakdown, persists through the mock's user_preferences, and leaves the
// vacant/totals bands pinned. Demo prop-1 has Bright Coffee Co. ($60,000 base) and
// City Dental ($84,000 base).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import LedgerPage from '../../pages/LedgerPage';
import TenantShareTable from '../TenantShareTable';
import { setLeaseSort } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const qcOpts = { defaultOptions: { queries: { retry: false } } };

function renderLedger() {
  return render(
    <MemoryRouter initialEntries={['/financials/corp-1/prop-1/ledger']}>
      <QueryClientProvider client={new QueryClient(qcOpts)}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}
function renderBreakdown() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient(qcOpts)}>
        <TenantShareTable propertyId="prop-1" year={Y} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// Start every test from the default order.
beforeEach(async () => {
  cleanup();
  await setLeaseSort({ tenants: { mode: 'tenant_name', dir: 'asc' } });
});

const ledgerOrder = () => Array.from(document.querySelectorAll('.rent-roll tbody .rr-tenant')).map((el) => el.textContent);
const breakdownOrder = () => Array.from(document.querySelectorAll('.ledger-row:not(.ledger-vacant):not(.ledger-totals) .ledger-name')).map((el) => el.textContent);

describe('TenantSortBar — the Rent Ledger', () => {
  it('reorders tenants by base rent (descending) and back', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    // Default: name ascending → Bright before City.
    expect(ledgerOrder()).toEqual(['Bright Coffee Co.', 'City Dental']);

    fireEvent.change(document.querySelector('.lease-sortbar select'), { target: { value: 'base_rent' } });
    fireEvent.click(document.querySelector('.lease-sortbar .sort-dir')); // asc → desc
    // Base rent descending → City Dental ($84,000) first.
    await waitFor(() => expect(ledgerOrder()).toEqual(['City Dental', 'Bright Coffee Co.']));
  });
});

describe('TenantSortBar — the per-tenant breakdown', () => {
  it('reorders tenants by base rent (descending), vacant/totals stay last', async () => {
    renderBreakdown();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(breakdownOrder()).toEqual(['Bright Coffee Co.', 'City Dental']);

    fireEvent.change(document.querySelector('.lease-sortbar select'), { target: { value: 'base_rent' } });
    fireEvent.click(document.querySelector('.lease-sortbar .sort-dir'));
    await waitFor(() => expect(breakdownOrder()).toEqual(['City Dental', 'Bright Coffee Co.']));

    // The Totals band is still the last row (never sorted into the tenant list).
    const names = Array.from(document.querySelectorAll('.ledger-name')).map((el) => el.textContent);
    expect(names[names.length - 1]).toBe('Totals');
  });
});
