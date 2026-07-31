// The "CAM & tax estimates read from this statement" section of the review: checking a
// tenant deposit surfaces the derived estimate (deposit − base = CAM&tax → /yr), a NEW
// estimate is pre-ticked, and a change to an EXISTING one arrives unticked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();

// Flipped per-test to make Bright Coffee a GROSS lease. Hoisted so the mock factory —
// which vitest lifts above these imports — can close over it without a TDZ error.
const state = vi.hoisted(() => ({ brightIsGross: false }));

// Two controlled tenants: City Dental with NO estimate (base $7,000/mo), Bright Coffee
// WITH one (base $5,000/mo, currently billing $16,500 CAM&tax).
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal();
  const tenant = (over) => ({
    property_id: 'prop-1', property_name: 'Maple Plaza', steps: [],
    owed: Array(12).fill(over.owedM), coverage: Array(12).fill(0), monthly: over.owedM,
    invoiceTotal: over.owedM * 12, invoiceBalance: null, reconInvoiceId: null, reconBalance: 0,
    tenant_email: null, tenant_email_2: null, contact_name: null, ...over,
  });
  return {
    ...actual,
    getStatementMatchContext: vi.fn(async () => ({
      properties: [{ id: 'prop-1', name: 'Maple Plaza', corporation_id: 'corp-1' }],
      rules: [], existingHashes: new Set(), accountMemory: {}, buckets: [], businessByProperty: {},
      tenants: [
        tenant({ lease_id: 'lease-2', tenant_name: 'City Dental', owedM: 9150, baseByMonth: Array(12).fill(7000), roofByMonth: Array(12).fill(0), square_footage: 1850, camTaxAnnual: 25800, anyEstimate: false }),
        tenant({ lease_id: 'lease-1', tenant_name: 'Bright Coffee', owedM: 6375, baseByMonth: Array(12).fill(5000), roofByMonth: Array(12).fill(0), square_footage: 2000, camTaxAnnual: 16500, anyEstimate: true, gross: state.brightIsGross }),
      ],
    })),
  };
});

const PARSED = {
  transactions: [
    { date: `${Y}-05-05`, description: 'CHECK 1044 CITY DENTAL PC', amount: 8000, direction: 'in', balance: null, line: 1 },
    { date: `${Y}-05-06`, description: 'CHECK 1055 BRIGHT COFFEE CO', amount: 7000, direction: 'in', balance: null, line: 2 },
  ],
  skippedLines: [], warnings: [],
};

function renderReview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="may.csv" parsed={PARSED} onCancel={() => {}} onSaved={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const depositRow = (text) => Array.from(document.querySelectorAll('.stmt-table tbody tr'))
  .find((tr) => new RegExp(text).test(tr.querySelector('.stmt-desc')?.textContent || '') && tr.querySelectorAll('select').length > 0);
const estSection = () => document.querySelector('.stmt-estimates');
const estRowFor = (name) => Array.from(estSection().querySelectorAll('tbody tr'))
  .find((tr) => new RegExp(name).test(tr.textContent || ''));

beforeEach(() => { cleanup(); state.brightIsGross = false; });

describe('StatementReview — CAM & tax estimates read from the statement', () => {
  it('derives a NEW estimate (pre-ticked) and a CHANGE to an existing one (unticked)', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    // No estimate section until a deposit is checked.
    expect(estSection()).toBe(null);

    // Include both deposits.
    fireEvent.click(depositRow('CITY DENTAL').querySelector('input[type=checkbox]'));
    fireEvent.click(depositRow('BRIGHT COFFEE').querySelector('input[type=checkbox]'));

    await waitFor(() => expect(screen.getByText(/CAM & tax estimates read from this statement/)).toBeTruthy());

    // City Dental has NO estimate → derived $1,000/mo → $12,000/yr, pre-ticked.
    // (Figures shown to 4 decimals so George can validate the math.)
    const city = estRowFor('City Dental');
    expect(within(city).getByText(/\$12,000\.0000\/yr/)).toBeTruthy();
    expect(city.querySelector('input[type=checkbox]').checked).toBe(true);

    // Bright Coffee already bills $16,500 → derived $2,000/mo → $24,000/yr, UNTICKED
    // (a change can't silently lower a good estimate).
    const bright = estRowFor('Bright Coffee');
    expect(within(bright).getByText(/\$24,000\.0000\/yr/)).toBeTruthy();
    expect(bright.querySelector('input[type=checkbox]').checked).toBe(false);

    // The footer counts only the ticked (pre-ticked) estimate.
    expect(document.querySelector('.stmt-footer').textContent).toMatch(/1 CAM & tax estimate/);
  });

  // 0073 — a gross deposit IS the whole flat rent, so "deposit − base" hands back the
  // share the breakdown already carved OUT of it. Proposing that as an estimate would
  // bill the same money twice, so the importer refuses — and SAYS it refused, because
  // an unexplained blank reads as the importer having missed the tenant.
  it('reads no estimate from a GROSS tenant, and names it rather than going quiet', async () => {
    state.brightIsGross = true;
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());

    fireEvent.click(depositRow('CITY DENTAL').querySelector('input[type=checkbox]'));
    fireEvent.click(depositRow('BRIGHT COFFEE').querySelector('input[type=checkbox]'));
    await waitFor(() => expect(estSection()).toBeTruthy());

    // The net tenant still derives normally — the refusal is per-lease, not per-import.
    expect(within(estRowFor('City Dental')).getByText(/\$12,000\.0000\/yr/)).toBeTruthy();
    // The gross tenant has NO row proposing a figure…
    expect(estRowFor('Bright Coffee')).toBeUndefined();
    // …and the section says why, by name.
    expect(estSection().textContent).toMatch(/No estimate is read for Bright Coffee/);
    expect(estSection().textContent).toMatch(/that lease is gross/);
    // Still only City Dental's estimate is queued to save.
    expect(document.querySelector('.stmt-footer').textContent).toMatch(/1 CAM & tax estimate/);
  });

  // The explanation must stand on its own: with ONLY gross deposits there are no
  // suggestions to hang it off, and that is exactly when the blank is most confusing.
  it('explains itself even when every deposit is gross and there is no table', async () => {
    state.brightIsGross = true;
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());

    fireEvent.click(depositRow('BRIGHT COFFEE').querySelector('input[type=checkbox]'));
    await waitFor(() => expect(estSection()).toBeTruthy());
    expect(estSection().querySelector('tbody')).toBe(null);   // no suggestions to show
    expect(estSection().textContent).toMatch(/No estimate is read for Bright Coffee/);
  });
});
