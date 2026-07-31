// The per-tenant breakdown for a GROSS lease (0073) — the surface George described:
// "if the actual was ten thousand, it would show that there's a difference of ten
// thousand in the per tenant breakdown … you would subtract ten thousand from the
// forty two thousand to get thirty two thousand."
//
// The arithmetic is pinned in reconciliation.test.js and the chain in grossLease.test.js.
// What only a render can prove is that the landlord SEES the carve: that the base cell
// shows the reduced figure with its derivation, that the total still reads the flat
// rent, and that the two controls which would let expenses be billed twice — the
// estimate editor and ⚖ Reconcile — are genuinely unreachable rather than merely
// harmless.
//
// Mounts the REAL TenantShareTable against the demo mock. The seed is untouched; the
// flip happens here (prop-1's Bright Coffee, which has a saved invoice and estimates,
// so it also proves a lease switched FROM net behaves).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { updateLease } from '../../lib/api';
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

// Bright Coffee (lease-1, prop-1): 2,000 SF of a 5,000 SF building, base $60,000/yr,
// roof-responsible. Actual share = 40% of (25,000 tax + 18,000 CAM) = $17,200, plus
// 40% of the $4,000 roof = $1,600 → $18,800 of expenses inside a $60,000 flat rent,
// leaving $41,200 of base.
const FLAT = 60000;
const CAMTAX = 17200;
const ROOF = 1600;
const BASE = FLAT - CAMTAX - ROOF; // 41,200

// Set the lease type, THEN mount — the table reads the share rows on load, so the flag
// has to be in place before the first fetch.
const row = async (name, leaseType) => {
  await updateLease('lease-1', { lease_type: leaseType });
  renderTable();
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  return screen.getByText(name).closest('.ledger-row');
};

beforeEach(() => cleanup());
afterAll(async () => { await updateLease('lease-1', { lease_type: null }); });

describe('TenantShareTable — a gross lease carves, and says so', () => {
  it('shows the carved base with its derivation, and the flat rent as the total', async () => {
    const r = await row('Bright Coffee Co.', 'gross');

    // The base is what's left of the rent after this tenant's expenses.
    expect(within(r).getByText('$41,200.00')).toBeTruthy();
    // …and it shows the subtraction, so the figure isn't just asserted at the landlord.
    expect(within(r).getByText(/flat \$60,000\.00 − \$18,800\.00 expenses/)).toBeTruthy();
    // The total is the flat rent — NOT 60,000 + 18,800, which is what a net lease bills.
    expect(within(r).getByText('$60,000.00')).toBeTruthy();
    expect(within(r).queryByText('$78,800.00')).toBeNull();
    // The row names itself so it doesn't read as a mis-priced net tenant — in the SAME
    // chip a net row gets, since they answer the same question about the same row. Pinned
    // exactly so no future round re-introduces a weight difference between the two.
    expect(r.querySelector('.lease-type-chip').textContent).toBe('Gross');
    expect(r.querySelector('.lease-type-chip').className).toBe('lease-type-chip');
  });

  it('makes the estimate un-editable and hides ⚖ Reconcile', async () => {
    const r = await row('Bright Coffee Co.', 'gross');

    // Bright Coffee still CARRIES estimates in the seed (6,500 + 10,000 + 1,500). On a
    // gross lease none of them bill, so the cell states that rather than showing a
    // figure nothing uses — and there is no button to open the editor with.
    expect(within(r).getByText('included in rent')).toBeTruthy();
    expect(within(r).queryByText('$16,500.00')).toBeNull();
    expect(within(r).queryByRole('button', { name: /set estimate|16,500/i })).toBeNull();

    // Nothing to true up at year end — the expenses came out of a rent that never moved.
    expect(within(r).queryByText(/⚖ Reconcile/)).toBeNull();
    expect(within(r).getByText(/gross — expenses included in rent/)).toBeTruthy();
  });

  it('still shows the ACTUAL share — the figure George reads the carve from', async () => {
    const r = await row('Bright Coffee Co.', 'gross');
    // The actual column is untouched by the carve: it's the tenant's real pro-rata
    // share, and it's what gets subtracted from the rent.
    expect(within(r).getByText('$17,200.00')).toBeTruthy();
    expect(within(r).getByText('$1,600.00')).toBeTruthy();
    expect(CAMTAX + ROOF).toBe(FLAT - BASE);
  });

  it('leaves the net tenants on the same property completely alone', async () => {
    const r = await row('City Dental', 'gross');
    // City Dental has no estimate → still offers to set one, still bills base + share.
    expect(within(r).getByText('＋ set estimate')).toBeTruthy();
    expect(within(r).getByText('$84,000.00')).toBeTruthy(); // its base, unchanged
  });

  it('reverts completely when switched back to net', async () => {
    const r = await row('Bright Coffee Co.', null);
    expect(within(r).getByText('$60,000.00')).toBeTruthy();      // base is the rent again
    expect(within(r).getByText('$16,500.00')).toBeTruthy();      // the estimate bills again
    // Back to NNN — labeled, not blank: an unlabeled row would be ambiguous between
    // "triple net" and "nobody has recorded which this is".
    expect(r.querySelector('.lease-type-chip').textContent).toBe('NNN');
    // …and in the identical chip the gross row wears: one format, the word does the work.
    expect(r.querySelector('.lease-type-chip').className).toBe('lease-type-chip');
    expect(within(r).queryByText(/flat \$60,000\.00 −/)).toBeNull();
  });
});
