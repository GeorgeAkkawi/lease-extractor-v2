// Slice 3's table, rendered against the demo mock — the figures a landlord actually reads.
//
// The seed is deliberately one of every case at once (prop-1, building 5,000 SF, fully
// let, Bright Coffee 2,000 SF roof-responsible):
//   • taxes  25,000 — entered as ONE flat figure, never itemized  → recovered in full
//   • CAM    18,000 across Landscaping / Snow removal / Security  → recovered in full
//   • roof    4,000 across two dated lines                        → only 40% recovered
//   • legal   1,200 marked "not billed to tenants"                → recovered NOTHING
// So the table shows both ways money is absorbed — a roof the leases don't pass on, and
// a cost the landlord chose to eat — which is the entire point of the column.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecoverabilityTable from '../RecoverabilityTable';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const withProviders = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
};

const rowFor = (text) =>
  [...document.querySelectorAll('.recov-row')].find((r) => r.textContent.includes(text));

beforeEach(() => cleanup());

describe('What it cost you', () => {
  it('shows spent, recovered and net for every category — and the columns add up', async () => {
    withProviders(<RecoverabilityTable propId="prop-1" corpId="corp-1" year={Y} />);
    await waitFor(() => expect(screen.getByText(`What it cost you — FY ${Y}`)).toBeTruthy());

    // The roof: spent in full, recovered only from the lease that makes the tenant
    // responsible. This row is the cross-check against v_property_totals.roof_recovered.
    const repairs = rowFor('Repairs');
    expect(within(repairs).getByText('$4,000.00')).toBeTruthy();
    expect(within(repairs).getByText('$1,600.00')).toBeTruthy();
    expect(within(repairs).getByText('$2,400.00')).toBeTruthy();

    // A cost the landlord chose to absorb recovers nothing and is carried in full.
    const legal = rowFor('Legal and professional');
    expect(within(legal).getByText('—')).toBeTruthy();
    expect(within(legal).getAllByText('$1,200.00').length).toBe(2); // spent AND net

    // The whole property: 25,000 + 19,200 + 4,000 spent, 44,600 back, 3,600 carried.
    const total = document.querySelector('.recov-total');
    expect(within(total).getByText('$48,200.00')).toBeTruthy();
    expect(within(total).getByText('$44,600.00')).toBeTruthy();
    expect(within(total).getByText('$3,600.00')).toBeTruthy();
    expect(total.textContent).toContain('Tenants cover 92.5% of what you spend');
  });

  it('names a kind entered as one flat figure rather than leaving it out', async () => {
    withProviders(<RecoverabilityTable propId="prop-1" corpId="corp-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Real estate taxes')).toBeTruthy());
    const taxes = rowFor('Real estate taxes');
    expect(taxes.textContent).toContain('Property taxes');
    expect(taxes.textContent).toContain('entered as one figure, not itemized');
    expect(within(taxes).getAllByText('$25,000.00').length).toBe(2); // spent AND recovered
  });

  // THE refusal, in the DOM: an uncategorized bucket is its own visible figure, last,
  // and is never folded into the "Other" category. It moved here from CamSection's
  // Slice 2 roll-up, which this table supersedes.
  it('keeps an uncategorized bucket visible and out of "Other"', async () => {
    withProviders(<RecoverabilityTable propId="prop-1" corpId="corp-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Not categorized')).toBeTruthy());
    const none = document.querySelector('.recov-row.cat-none');
    expect(none.textContent).toContain('Security');
    // Spent AND recovered in full — uncategorized is NOT the same thing as absorbed, and
    // the table must not let the gold nag imply the money was lost. Net is zero.
    expect(within(none).getAllByText('$6,000.00').length).toBe(2);
    expect(within(none).getByText('$0.00')).toBeTruthy();
    // Nothing was filed AS Other, and the nag is last before the totals line.
    expect(screen.queryByText('Other')).toBeNull();
    const rows = [...document.querySelectorAll('.recov-row:not(.recov-th):not(.recov-total)')];
    expect(rows[rows.length - 1]).toBe(none);
  });

  it('says nothing at all on a property with no expenses entered', async () => {
    withProviders(<RecoverabilityTable propId="prop-2" corpId="corp-1" year={Y} />);
    await waitFor(() => expect(document.querySelectorAll('.recov-row').length).toBe(0));
    expect(screen.queryByText(/What it cost you/)).toBeNull();
  });
});
