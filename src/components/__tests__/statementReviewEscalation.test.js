// Render tests for the escalation-aware statement review (against the demo mock):
//  1. a deposit still at the PRE-raise rate for a post-step month shows the QUIET
//     "matches the pre-raise rate" cue — NOT the amber "≠ projected" short chip —
//     the ✉ Draft letter stays, and the footer's mismatch count excludes it;
//  2. the click-gated 🤖 Suggest tenants button lands an AI suggestion UNCHECKED
//     with the AI chip (nothing books without the user's tick).
// A sibling of statementReviewMismatch.test.js (which keeps the genuinely-short amber
// case) so that pinned file stays byte-identical. Only getStatementMatchContext is
// patched — to make City Dental a stepped tenant; everything else is the real mock.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();

// Patch ONLY getStatementMatchContext: City Dental (lease-2) becomes a stepped tenant —
// Jan–May $9,150, Jun–Dec $9,550 (a June base step of $400), Jan–May already paid so
// June is the first open month. Everything else stays the real demo-mock implementation.
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
          owed: [9150, 9150, 9150, 9150, 9150, 9550, 9550, 9550, 9550, 9550, 9550, 9550],
          coverage: [9150, 9150, 9150, 9150, 9150, 0, 0, 0, 0, 0, 0, 0],
          monthly: 9550,
          steps: [{ month: 6, owed: 9550, base: 7550, prevBase: 7150 }],
        } : t),
      };
    }),
  };
});

function renderReview(parsed) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="jun.csv" accountHint="••4821" parsed={parsed} onCancel={() => {}} onSaved={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => cleanup());

describe('StatementReview — escalation-aware variance', () => {
  it('a pre-raise-rate deposit on a post-step month shows the quiet cue, not the amber short chip', async () => {
    renderReview({
      transactions: [{ date: `${Y}-06-05`, description: 'CHECK 1044 CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 }],
      skippedLines: [], warnings: [],
    });
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());
    const depRow = screen.getByText('CHECK 1044 CITY DENTAL PC').closest('tr');

    // The matcher tags it to June (the step month) and reads it as explained, not short.
    await waitFor(() => expect(within(depRow).getByText(/matches the pre-raise rate — rent stepped to \$9,550\.00 in June/)).toBeTruthy());
    expect(within(depRow).queryByText(/≠ projected/)).toBe(null);
    // The ✉ Draft letter still offers to notify the tenant of the (real) $400 difference.
    expect(within(depRow).getByText(/Draft letter/)).toBeTruthy();
    // The footer's mismatch count excludes an escalation-explained row.
    expect(document.querySelector('.stmt-footer').textContent).not.toContain('≠ projected');
  });

  it('🤖 Suggest tenants lands an AI suggestion UNCHECKED with the AI chip', async () => {
    renderReview({
      transactions: [{ date: `${Y}-03-09`, description: 'MOBILE DEPOSIT J PAK 2211', amount: 10416.67, direction: 'in', balance: null, line: 1 }],
      skippedLines: [], warnings: [],
    });
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());
    const depRow = screen.getByText('MOBILE DEPOSIT J PAK 2211').closest('tr');
    // Nothing recognized it → it's unchecked and the 🤖 Suggest tenants button shows.
    expect(depRow.querySelector('input[type=checkbox]').checked).toBe(false);
    const btn = screen.getByText(/🤖 Suggest tenants for 1 deposit/);

    // One click → the demo's canned matcher resolves "J PAK" to Northwind Books (lease-3).
    fireEvent.click(btn);
    await waitFor(() => expect(within(depRow).getByText('AI')).toBeTruthy());
    expect(depRow.querySelectorAll('select')[0].value).toBe('lease:lease-3');
    // Suggestions never auto-book — the row stays unchecked until the user ticks it.
    expect(depRow.querySelector('input[type=checkbox]').checked).toBe(false);
  });
});
