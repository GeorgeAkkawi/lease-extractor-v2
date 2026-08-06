// Slice 4b in the DOM — the gap between NOI and what is actually in the account.
//
// The demo seed carries one of every case at once on prop-1: $1,200 of legal fees the
// landlord entered and chose NOT to bill back (billable:false, seeded in round 4), plus
// a $24,000 draw, a $5,000 contribution and a $1,750 entity cost (seeded here). So the
// strip shows every movement NOI has never known about, and the panel shows the two
// kinds of money that are not expenses at all.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import WhatStayedStrip from '../WhatStayedStrip';
import EntityLedgerSection from '../EntityLedgerSection';
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

const rowFor = (text) => [...document.querySelectorAll('.stayed-row')].find((r) => r.textContent.includes(text));

beforeEach(() => cleanup());

describe('What actually stayed', () => {
  it('subtracts every movement NOI has never known about, and ties to its own rows', async () => {
    withProviders(<WhatStayedStrip propId="prop-1" year={Y} noi={100000} />);
    await waitFor(() => expect(screen.getByText(`What actually stayed · FY ${Y}`)).toBeTruthy());

    // NOI is quoted UNCHANGED — the whole design refuses to redefine it, because
    // v_property_totals.noi is baked into every chart point and every closed-year
    // snapshot already written.
    expect(within(rowFor('Net operating income')).getByText('$100,000.00')).toBeTruthy();
    // The $1,200 of legal fees: visible on the Expense entry since round 4 and
    // reaching NO total until now. This is the round that counts it.
    expect(within(rowFor('Costs you absorbed')).getByText('$1,200.00')).toBeTruthy();
    expect(within(rowFor('Owner draws')).getByText('$24,000.00')).toBeTruthy();
    expect(within(rowFor('Entity costs')).getByText('$1,750.00')).toBeTruthy();
    expect(within(rowFor('Owner contributions')).getByText('$5,000.00')).toBeTruthy();
    // Slice 4c filled the `otherIncome` slot this strip was built with and left empty:
    // $250 late fee + $1,800 parking + $640 utility reimbursement, none of which rode
    // an invoice, so NOI has never counted a penny of it.
    expect(within(rowFor('Other income')).getByText('$2,690.00')).toBeTruthy();

    // 100,000 + 2,690 + 5,000 − 1,200 − 1,750 − 24,000 = 80,740
    expect(within(rowFor('What actually stayed')).getByText('$80,740.00')).toBeTruthy();
    // Every sign is load-bearing: the two money-IN lines add and the three money-OUT
    // lines subtract. A sign flip here would be an arithmetically tidy lie.
    const signs = [...document.querySelectorAll('.stayed-row')]
      .map((r) => [r.textContent.replace(/\s+/g, ' ').trim(), r.querySelector('.stayed-op')?.textContent])
      .filter(([, op]) => op);
    expect(signs.find(([t]) => t.startsWith('+Other income'))?.[1]).toBe('+');
    expect(signs.find(([t]) => t.startsWith('+Owner contributions'))?.[1]).toBe('+');
    expect(signs.find(([t]) => t.startsWith('−Owner draws'))?.[1]).toBe('−');
  });

  it('says nothing at all when there is nothing to reconcile', async () => {
    // prop-2 has no not-billed costs and no entity money — a strip reading
    // "NOI $X = what stayed $X" is a row of noise posing as a finding.
    withProviders(<WhatStayedStrip propId="prop-2" year={Y} noi={50000} />);
    await waitFor(() => expect(document.querySelectorAll('.stayed-row').length).toBe(0));
    expect(screen.queryByText(/What actually stayed/)).toBeNull();
  });
});

describe('Owner & entity money', () => {
  it('groups by kind with its own totals, and never claims to be an expense', async () => {
    withProviders(<EntityLedgerSection propId="prop-1" corporationId="corp-1" year={Y} />);
    // Wait on the DATA, not the heading — the heading renders before the query
    // resolves, so waiting on it proves nothing.
    await waitFor(() => expect(screen.getByText('Owner distribution')).toBeTruthy());
    expect(screen.getByText(`Owner & entity money · FY ${Y}`)).toBeTruthy();
    expect(screen.getByText('Illinois franchise tax')).toBeTruthy();
    expect(screen.getByText('Capital call — roof work')).toBeTruthy();
    // The claim the whole slice rests on, stated on screen where a landlord can read it.
    expect(document.body.textContent).toContain('None of it reaches a tenant’s bill');
  });

  it('offers a tax category to an entity cost and to nothing else', async () => {
    withProviders(<EntityLedgerSection propId="prop-1" corporationId="corp-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Illinois franchise tax')).toBeTruthy());

    // Exactly one TAX-CATEGORY chip — the entity cost's. A draw files on no line of any
    // return, so offering it a category would invite a wrong answer.
    // (0098's "paid to" chip borrows the same styling and is excluded by class, not by
    // count: every row now carries one, and a bare `.cat-chip` count would stop testing
    // what this is about.)
    const chips = [...document.querySelectorAll('.cat-chip:not(.party-chip)')];
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('Set a tax category');
    expect(chips[0].closest('.cam-row').textContent).toContain('Illinois franchise tax');

    fireEvent.click(chips[0]);
    const sel = await screen.findByDisplayValue('No category');
    fireEvent.change(sel, { target: { value: 'taxes' } });
    await waitFor(() => expect(screen.getByText('Real estate taxes')).toBeTruthy());
  });

  it('recording a draw by hand moves no expense total and no tenant’s share', async () => {
    const before = { cam: await getExpenseRecord('prop-1', Y), shares: await getTenantShares('prop-1', Y) };
    withProviders(<EntityLedgerSection propId="prop-1" corporationId="corp-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Owner distribution')).toBeTruthy());

    fireEvent.click(screen.getByText('＋ Record one'));
    fireEvent.change(screen.getByPlaceholderText('What it was (optional)'), { target: { value: 'March draw' } });
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '3000' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(screen.getByText('March draw')).toBeTruthy());
    const after = await getExpenseRecord('prop-1', Y);
    expect(after.cam_total).toBe(before.cam.cam_total);
    expect((await getTenantShares('prop-1', Y)).map((s) => s.total_due))
      .toEqual(before.shares.map((s) => s.total_due));
  });
});
