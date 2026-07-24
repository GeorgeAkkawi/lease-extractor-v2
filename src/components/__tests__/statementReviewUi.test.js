// Render tests for the statement review's legibility fixes (against the demo mock),
// each locking one thing George couldn't read on his real Chase import:
//  1. the tenant dropdown leads with the property you're standing in — the rest of the
//     portfolio stays reachable under "Other properties", never padding the main list;
//  2. every column has a name, and there is exactly one tick per row to understand;
//  3. "For month" is the month the bank printed on the line, and a month he picks wins;
//  4. clicking one 🤖 helper puts only that button into "Suggesting…".
// A sibling of statementReviewMismatch/Escalation so those files stay untouched.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();

// Hold the 🤖 call open so the in-flight state is observable — the bug was that a
// shared busy flag made BOTH helpers say "Suggesting…" when only one had started.
const h = vi.hoisted(() => ({ resolveSuggest: null }));

// City Dental (lease-2) owes $9,150 a month with Jan–May already covered, so June is
// the earliest month still owed. Everything else is the real demo mock.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStatementMatchContext: vi.fn(async (propertyId, year) => {
      const ctx = await actual.getStatementMatchContext(propertyId, year);
      return {
        ...ctx,
        tenants: ctx.tenants.map((t) => t.lease_id === 'lease-2' ? {
          ...t,
          owed: Array(12).fill(9150),
          coverage: [9150, 9150, 9150, 9150, 9150, 0, 0, 0, 0, 0, 0, 0],
          monthly: 9150,
        } : t),
      };
    }),
    suggestTenantMatches: vi.fn(() => new Promise((res) => { h.resolveSuggest = res; })),
  };
});

// One month so the group renders open: a recognized deposit, a deposit nothing knows,
// and an expense nothing knows — enough for both 🤖 helpers to be on screen at once.
const PARSED = {
  transactions: [
    { date: `${Y}-08-05`, description: 'CHECK 1044 CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 },
    { date: `${Y}-08-06`, description: 'Orig CO Name:Quarry Lane Holdings Orig ID:9200502235 Desc Date:080126', amount: 1234.56, direction: 'in', balance: null, line: 2 },
    { date: `${Y}-08-07`, description: 'ACME WIDGETS LLC PMT 88213', amount: 500, direction: 'out', balance: null, line: 3 },
    { date: `${Y}-08-08`, description: 'SNOW REMOVAL SERVICE INV 4412', amount: 900, direction: 'out', balance: null, line: 4 },
  ],
  skippedLines: [], warnings: [],
};

function renderReview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="aug.csv" accountHint="••4821" parsed={PARSED} onCancel={() => {}} onSaved={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// Match on the DESCRIPTION cell: a checked row also names the payee it will
// remember, so a bare text search finds the same wording twice.
const rowFor = (text) => Array.from(document.querySelectorAll('.stmt-table tbody tr'))
  .find((tr) => new RegExp(text).test(tr.querySelector('.stmt-desc')?.textContent || ''));
const optionsOf = (sel, label) => Array.from(sel.querySelector(`optgroup[label="${label}"]`).querySelectorAll('option')).map((o) => o.textContent);

beforeEach(() => { cleanup(); h.resolveSuggest = null; });

describe('StatementReview — reading the lines', () => {
  it('leads with this property\'s tenants; the rest of the portfolio stays under "Other properties"', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    const sel = rowFor('CHECK 1044 CITY DENTAL PC').querySelectorAll('select')[0];
    const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label);

    expect(groups).toContain('Maple Plaza tenants');
    expect(groups[groups.length - 1]).toBe('Other properties');
    // The home group names tenants plainly — no property suffix, nothing from Oak Center.
    const home = optionsOf(sel, 'Maple Plaza tenants');
    expect(home).toContain('Bright Coffee Co.');
    expect(home.some((t) => /Oak Center|Northwind|Sunrise/.test(t))).toBe(false);
    // One bank account serves the portfolio, so the others stay pickable — just apart.
    expect(optionsOf(sel, 'Other properties')).toContain('Northwind Books — Oak Center');
  });

  it('names every column, and no row asks for a second tick', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    // Both tables share one header row component, so they can't drift apart.
    for (const table of document.querySelectorAll('.stmt-table')) {
      expect(Array.from(table.querySelectorAll('thead th')).map((t) => t.textContent))
        .toEqual(['Import', 'Date', 'Description', 'Amount', 'Record as', 'For month', 'Match']);
    }

    // One tick per row — include. Deposits and expenses alike remember their payee by
    // being saved, so the "Always" column George couldn't make sense of is gone.
    expect(rowFor('CHECK 1044 CITY DENTAL PC').querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    expect(rowFor('SNOW REMOVAL SERVICE').querySelectorAll('input[type=checkbox]')).toHaveLength(1);
  });

  it('dates a deposit from the statement, and never argues with a month you choose', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    const depRow = rowFor('CHECK 1044 CITY DENTAL PC');
    const monthSel = depRow.querySelectorAll('select')[1];

    // Posted in August — so it's August, even though June is the earliest month still
    // owed. An August statement records August.
    await waitFor(() => expect(monthSel.value).toBe('8'));

    // And the landlord's own choice always wins.
    fireEvent.change(monthSel, { target: { value: '6' } });
    expect(monthSel.value).toBe('6');
  });

  it('only the 🤖 helper you clicked says "Suggesting…"', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    expect(screen.getByText(/Suggest tenants/)).toBeTruthy();
    expect(screen.getByText(/Suggest buckets/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Suggest tenants/));
    await waitFor(() => expect(screen.getAllByText('Suggesting…')).toHaveLength(1));
    // The other helper keeps its own label — it's waiting its turn, not also running.
    expect(screen.getByText(/Suggest buckets/)).toBeTruthy();

    h.resolveSuggest({ suggestions: [] });
    await waitFor(() => expect(screen.queryByText('Suggesting…')).toBe(null));
  });
});
