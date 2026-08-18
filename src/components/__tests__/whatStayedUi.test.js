// The gap between NOI and what is actually in the account, in the DOM.
//
// The demo seed carries every case at once on prop-1, and since the entity ledger was
// retired (2026-08-12) they all live in ONE place — the "not billed to tenants" group on
// cam_line_items:
//   • $1,200 owner legal fees   — a cost the landlord absorbed        (category: legal)
//   • $1,750 franchise tax      — a cost of the LLC, also absorbed    (category: legal)
//   • $24,000 "Dana Whitfield"  — money the OWNER took out            (category: distribution)
// plus $2,690 of other income that never rode an invoice.
//
// ⚠ THE POINT OF THIS FILE. Those three rows are the SAME SHAPE in the database —
// `billable: false` lines on cam_line_items — and only the bucket's category tells the
// third apart from the first two. That is what made retiring a whole table safe, and it
// is also the thing that would break silently: sum them and "money you took out" appears
// under "costs you absorbed"; bill them and a distribution lands on a tenant's invoice.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import WhatStayedStrip from '../WhatStayedStrip';
import CamSection from '../CamSection';
import { getExpenseRecord, getTenantShares } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const withProviders = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const rowFor = (text) =>
  [...document.querySelectorAll('.stayed-row')].find((r) => r.textContent.includes(text));

beforeEach(() => cleanup());

describe('What actually stayed', () => {
  it('subtracts every movement NOI has never known about, and ties to its own rows', async () => {
    withProviders(<WhatStayedStrip propId="prop-1" year={Y} noi={100000} />);
    await waitFor(() => expect(screen.getByText(`What actually stayed · FY ${Y}`)).toBeTruthy());

    // NOI is quoted UNCHANGED — the whole design refuses to redefine it, because
    // v_property_totals.noi is baked into every chart point and every closed-year
    // snapshot already written.
    expect(within(rowFor('Net operating income')).getByText('$100,000.00')).toBeTruthy();

    // The two absorbed costs, summed — and the distribution kept out of them.
    expect(within(rowFor('Costs you absorbed')).getByText('$2,950.00')).toBeTruthy();
    expect(within(rowFor('Owner distributions')).getByText('$24,000.00')).toBeTruthy();

    // Money in that never rode an invoice: $250 late fee + $1,800 parking + $640 utility
    // reimbursement, so NOI has never counted a penny of it.
    expect(within(rowFor('Other income')).getByText('$2,690.00')).toBeTruthy();

    // 100,000 + 2,690 − 2,950 − 24,000 = 75,740
    expect(within(rowFor('What actually stayed')).getByText('$75,740.00')).toBeTruthy();

    // Every sign is load-bearing: money-IN adds and money-OUT subtracts. A sign flip
    // here would be an arithmetically tidy lie.
    const signs = [...document.querySelectorAll('.stayed-row')]
      .map((r) => [r.textContent.replace(/\s+/g, ' ').trim(), r.querySelector('.stayed-op')?.textContent])
      .filter(([, op]) => op);
    expect(signs.find(([t]) => t.startsWith('+Other income'))?.[1]).toBe('+');
    expect(signs.find(([t]) => t.startsWith('−Costs you absorbed'))?.[1]).toBe('−');
    expect(signs.find(([t]) => t.startsWith('−Owner distributions'))?.[1]).toBe('−');
  });

  it('names the distribution as equity rather than letting it read as a cost', async () => {
    withProviders(<WhatStayedStrip propId="prop-1" year={Y} noi={100000} />);
    await waitFor(() => expect(screen.getByText(`What actually stayed · FY ${Y}`)).toBeTruthy());
    expect(document.body.textContent).toContain('A distribution is not an expense');
    // The absorbed line counts the two real costs and NOT the draw — a "3 expense lines"
    // footnote would be the same conflation one sentence lower down.
    expect(document.body.textContent).toContain('2 expense lines you entered and chose not to bill back');
  });

  it('says nothing at all when there is nothing to reconcile', async () => {
    // prop-2 has no not-billed costs and no owner money — a strip reading
    // "NOI $X = what stayed $X" is a row of noise posing as a finding.
    withProviders(<WhatStayedStrip propId="prop-2" year={Y} noi={50000} />);
    await waitFor(() => expect(document.querySelectorAll('.stayed-row').length).toBe(0));
    expect(screen.queryByText(/What actually stayed/)).toBeNull();
  });
});

describe('recording owner money where it now lives', () => {
  // The invariant the retirement had to preserve, exercised through the UI a landlord
  // actually uses. Before 2026-08-12 a draw went into its own table, which could not
  // move a bill because it touched nothing. Now it is a row on the SAME table CAM bills
  // from, and only `billable: false` keeps it inert — so this is no longer true by
  // construction and has to be tested.
  it('recording a distribution by hand moves no expense total and no tenant’s share', async () => {
    const before = { cam: await getExpenseRecord('prop-1', Y), shares: await getTenantShares('prop-1', Y) };
    withProviders(<CamSection propId="prop-1" year={Y} expense={before.cam} />);
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./), { target: { value: 'Yazin Akkawi' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '3000' } });
    // The tick that makes it the landlord's own money rather than the building's.
    fireEvent.click(within(screen.getByText('not billed').closest('label')).getByRole('checkbox'));
    fireEvent.click(screen.getByTitle('Add expense item'));

    // Scoped past the label picker: in a browser, the pointerdown on ＋ shuts it, but
    // fireEvent.click raises no pointer event, so its options stay rendered here and the
    // newly-added name is legitimately on the page twice.
    await waitFor(() => expect(
      screen.getAllByText('Yazin Akkawi').some((n) => !n.closest('[role="option"]'))
    ).toBe(true));
    const after = await getExpenseRecord('prop-1', Y);
    expect(after.cam_total).toBe(before.cam.cam_total);
    expect((await getTenantShares('prop-1', Y)).map((s) => s.total_due))
      .toEqual(before.shares.map((s) => s.total_due));
  });
});
