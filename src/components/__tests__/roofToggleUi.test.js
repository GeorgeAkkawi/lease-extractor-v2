// The Roof column, rendered against the REAL TenantShareTable and the demo mock (0097).
//
// The pure rule is covered in src/lib/__tests__/roofDisplay.test.js; what THIS file guards is
// the wiring, which has its own failure mode: the gate reads `property.roof_separate`, and the
// property arrives from a SECOND query (`['property', id]`) that the table happens to already
// run. Break that and the column silently follows the wrong building — or, worse, follows
// `undefined` and vanishes for everyone.
//
// Demo seed: prop-1 (Maple Plaza) has a roof total AND lease-1 roof-responsible; prop-2 (Oak
// Center) has a roof total and NO roof-responsible lease. So prop-2 with its roof cleared is
// the only "this building doesn't do roof" case the seed can produce.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import { supabase } from '../../lib/supabaseClient';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderTable(propertyId) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TenantShareTable propertyId={propertyId} year={Y} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const RESET = async () => {
  await supabase.from('properties').update({ roof_separate: true }).eq('id', 'prop-1');
  await supabase.from('properties').update({ roof_separate: true }).eq('id', 'prop-2');
  await supabase.from('expense_records').update({ roof_total: 12000 }).eq('id', 'exp-3');
};
beforeEach(RESET);
afterEach(async () => { cleanup(); await RESET(); });

// The Stat cells label themselves with a plain <span class="stat-label">, not an aria-label —
// it doubles as the visible eyebrow on narrow screens. So the column is found by its text, and
// "Roof · actual" appears exactly where the column exists: once per tenant row, once on totals.
const roofCells = () => screen.queryAllByText('Roof · actual');

describe('the Roof column follows the property’s own checkbox', () => {
  it('is there by default', async () => {
    renderTable('prop-1');
    await waitFor(() => expect(roofCells().length).toBeGreaterThan(0));
  });

  it('stays when the box is unticked but a tenant is still charged for the roof', async () => {
    await supabase.from('properties').update({ roof_separate: false }).eq('id', 'prop-1');
    renderTable('prop-1');
    // lease-1 is roof_responsible — hiding the column here would leave Bright Coffee paying a
    // roof share the breakdown no longer mentions.
    await waitFor(() => expect(roofCells().length).toBeGreaterThan(0));
  });

  it('goes away when the building says no and no tenant has a roof share', async () => {
    await supabase.from('expense_records').update({ roof_total: 0 }).eq('id', 'exp-3');
    await supabase.from('properties').update({ roof_separate: false }).eq('id', 'prop-2');
    renderTable('prop-2');
    // Wait for the table itself, then assert the roof cells are absent rather than racing an
    // empty render into a passing assertion.
    await waitFor(() => expect(screen.getByText('Totals')).toBeTruthy());
    expect(roofCells()).toHaveLength(0);
    // The note explains where roof went instead of dropping the column silently.
    expect(screen.getByText(/doesn’t bill roof separately/)).toBeTruthy();
  });

  it('comes straight back when the box is re-ticked, even with nothing on it', async () => {
    await supabase.from('expense_records').update({ roof_total: 0 }).eq('id', 'exp-3');
    await supabase.from('properties').update({ roof_separate: true }).eq('id', 'prop-2');
    renderTable('prop-2');
    await waitFor(() => expect(roofCells().length).toBeGreaterThan(0));
  });
});
