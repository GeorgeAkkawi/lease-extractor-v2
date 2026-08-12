// Slice 4c in the DOM.
//
// The demo seed carries one of every case on prop-1: a $250 late fee that NAMES City
// Dental (attribution without billing — the case the whole table exists for), $1,800 of
// parking and $640 of utility reimbursement from no particular tenant, plus lease-1's
// stated $10,000 security deposit.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import WhatStayedStrip from '../WhatStayedStrip';
import OtherIncomeSection from '../OtherIncomeSection';
import StatementReview from '../StatementReview';
import { getYearInvoice, listPayments } from '../../lib/api';
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

describe('Other income on the Financials page', () => {
  it('groups by category with its own subtotals, and never claims to be rent', async () => {
    withProviders(<OtherIncomeSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Lot 2 monthly permits')).toBeTruthy());
    expect(screen.getByText(`Other income · FY ${Y}`)).toBeTruthy();
    expect(screen.getByText('Late fee — March rent')).toBeTruthy();
    expect(screen.getByText('Water reimbursement')).toBeTruthy();
    // 250 + 1800 + 640 = 2690, and the claim the slice rests on, on screen.
    expect(document.body.textContent).toContain('$2,690.00');
    expect(document.body.textContent).toMatch(/no invoice and no\s+tenant’s Collected figure includes it/);
  });

  // Attribution WITHOUT billing: the tenant is named here and nowhere near their invoice.
  it('names the tenant a late fee came from, while their rent stands still', async () => {
    const before = { inv: await getYearInvoice('lease-2', Y) };
    before.payments = await listPayments(before.inv.id);
    withProviders(<OtherIncomeSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Late fee — March rent')).toBeTruthy());
    expect(screen.getByText('from City Dental')).toBeTruthy();
    const after = await getYearInvoice('lease-2', Y);
    expect(after.amount_paid).toBe(before.inv.amount_paid);
    expect((await listPayments(after.id)).length).toBe(before.payments.length);
  });

  it('every row already carries a category, so there is no gold "unset" state to nag about', async () => {
    withProviders(<OtherIncomeSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Lot 2 monthly permits')).toBeTruthy());
    const chips = [...document.querySelectorAll('.cat-chip')];
    expect(chips).toHaveLength(3);
    // Unlike an expense bucket's, none is the "nobody has decided" variant — the pick
    // is made at the moment the money is placed.
    expect(chips.every((c) => !c.className.includes('none'))).toBe(true);
    fireEvent.click(chips.find((c) => c.textContent === 'Late fees'));
    const sel = await screen.findByDisplayValue('Late fees');
    fireEvent.change(sel, { target: { value: 'laundry' } });
    await waitFor(() => expect(screen.getByText('Laundry and vending')).toBeTruthy());
  });
});

describe('What actually stayed, with income in it', () => {
  it('ADDS other income and subtracts everything else, tying to its own rows', async () => {
    withProviders(<WhatStayedStrip propId="prop-1" year={Y} noi={100000} />);
    await waitFor(() => expect(screen.getByText(`What actually stayed · FY ${Y}`)).toBeTruthy());

    expect(within(rowFor('Other income')).getByText('$2,690.00')).toBeTruthy();
    expect(within(rowFor('Other income')).getByText('+')).toBeTruthy();

    // ⚠ THE TWO NOT-BILLED FIGURES ARE SPLIT, NOT SUMMED, and that is the assertion
    // worth having here. Since the entity ledger was retired (2026-08-12) a draw and an
    // absorbed cost are the SAME SHAPE in the database — both `billable: false` rows on
    // cam_line_items — and only the bucket's category tells them apart. Summing them
    // would put "money you took out" under the label "costs you absorbed", which is the
    // exact misstatement the entity ledger existed to prevent.
    expect(within(rowFor('Costs you absorbed')).getByText('$2,950.00')).toBeTruthy(); // 1,200 + 1,750
    expect(within(rowFor('Owner distributions')).getByText('$24,000.00')).toBeTruthy();

    // 100,000 + 2,690 − 2,950 − 24,000 = 75,740
    expect(within(rowFor('What actually stayed')).getByText('$75,740.00')).toBeTruthy();
  });
});

describe('the review screen, on the case that corrupts a figure', () => {
  // A FACTORY, not a shared literal — StatementReview consumes what it is handed, so
  // reusing one object across renders leaves the second with no transactions.
  const parsed = () => ({
    transactions: [
      // Says so in words → the matcher should suggest a DEPOSIT, not rent.
      { date: `${Y}-03-04`, description: 'ACH SECURITY DEPOSIT BRIGHT COFFEE', amount: 10000, direction: 'in', balance: null, line: 1 },
      { date: `${Y}-03-12`, description: 'ACH LATE FEE CITY DENTAL', amount: 250, direction: 'in', balance: null, line: 2 },
    ],
    skippedLines: [],
    warnings: [],
  });
  const renderReview = () => withProviders(
    <StatementReview propertyId="prop-1" year={Y} fileName="s.csv" parsed={parsed()} onCancel={() => {}} onSaved={() => {}} />
  );

  it('suggests a security deposit rather than rent, and leaves it unticked', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/ACH SECURITY DEPOSIT BRIGHT COFFEE/)).toBeTruthy());
    const sel = [...document.querySelectorAll('select')].find((s) => s.value.startsWith('deposit:'));
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('deposit:lease-1');
    // Nothing that isn't rent is ever auto-ticked — the cost of being wrong is a
    // corrupted Ledger, and there is no cheap way back from one.
    const box = sel.closest('tr').querySelector('input[type="checkbox"]');
    expect(box.checked).toBe(false);
  });

  it('offers a home for income that is not rent, per category', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/ACH LATE FEE CITY DENTAL/)).toBeTruthy());
    const row = screen.getByText(/ACH LATE FEE CITY DENTAL/).closest('tr');
    const sel = row.querySelector('select');
    const groups = [...sel.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toContain('Other income — not rent');
    expect(groups).toContain('Security deposit from…');
    // The tenant list stays ABOVE the non-rent groups: rent is still the common case.
    expect(groups.indexOf('Maple Plaza tenants')).toBeLessThan(groups.indexOf('Other income — not rent'));
    fireEvent.change(sel, { target: { value: 'income:late_fee' } });
    await waitFor(() => expect(sel.value).toBe('income:late_fee'));
  });

  // The matcher suggests a deposit for a tenant it RECOGNIZED — and that tenant is a
  // candidate, so a deposit list built from `pickable` would filter them out and leave
  // the select with no option matching its own value, rendering blank.
  it('lists the recognized tenant in the deposit group, so the suggestion can render', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/ACH SECURITY DEPOSIT BRIGHT COFFEE/)).toBeTruthy());
    const row = screen.getByText(/ACH SECURITY DEPOSIT BRIGHT COFFEE/).closest('tr');
    const group = [...row.querySelectorAll('optgroup')].find((g) => g.label === 'Security deposit from…');
    expect([...group.querySelectorAll('option')].map((o) => o.value)).toContain('deposit:lease-1');
  });
});
