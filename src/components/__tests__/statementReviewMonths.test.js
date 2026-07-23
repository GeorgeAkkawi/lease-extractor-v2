// Render test for the month-grouped statement review (against the demo mock). A
// two-month statement: April carries a keyword-matched expense (auto-classified,
// nothing to look at) so it starts collapsed; May carries an unmatched deposit so
// it starts open. Sibling of statementReviewMismatch (kept byte-identical) — this
// exercises the collapse/expand behavior the month grouping adds.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();

// April: a Landscaping expense (CAM keyword → confident → pre-checked = all matched).
// May: a deposit no tenant name matches (unmatched → needs review).
const twoMonths = () => ({
  transactions: [
    { date: `${Y}-04-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 1 },
    { date: `${Y}-05-10`, description: 'UNKNOWN PAYER QZ001', amount: 1234.56, direction: 'in', balance: null, line: 2 },
  ],
  skippedLines: [],
  warnings: [],
});

const oneMonth = () => ({
  transactions: [
    { date: `${Y}-04-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 1 },
  ],
  skippedLines: [],
  warnings: [],
});

function renderReview(parsed, onSaved = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="stmt.csv" parsed={parsed} onCancel={() => {}} onSaved={onSaved} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const monthHeader = (label) => screen.getByText(new RegExp(label));

beforeEach(() => cleanup());

describe('StatementReview — month grouping', () => {
  it('collapses an all-matched month and opens a month that needs review', async () => {
    renderReview(twoMonths());
    await waitFor(() => expect(monthHeader('April 2026')).toBeTruthy());

    // April is all matched → collapsed → its row is NOT in the DOM.
    expect(monthHeader('April 2026').textContent).toMatch(/all matched ✓/);
    expect(screen.queryByText('GREENLEAF LANDSCAPING INV 88')).toBeNull();

    // May needs review → open → its deposit row IS in the DOM.
    expect(monthHeader('May 2026').textContent).toMatch(/need review/);
    expect(screen.getByText('UNKNOWN PAYER QZ001')).toBeTruthy();
  });

  it('clicking a collapsed month reveals then re-collapses its rows', async () => {
    renderReview(twoMonths());
    await waitFor(() => expect(monthHeader('April 2026')).toBeTruthy());

    fireEvent.click(monthHeader('April 2026'));
    await waitFor(() => expect(screen.getByText('GREENLEAF LANDSCAPING INV 88')).toBeTruthy());
    fireEvent.click(monthHeader('April 2026'));
    await waitFor(() => expect(screen.queryByText('GREENLEAF LANDSCAPING INV 88')).toBeNull());
  });

  it('a single-month statement always starts open, even when fully matched', async () => {
    renderReview(oneMonth());
    await waitFor(() => expect(monthHeader('April 2026')).toBeTruthy());
    // Single month → open despite "all matched", so its row renders.
    expect(monthHeader('April 2026').textContent).toMatch(/all matched ✓/);
    expect(screen.getByText('GREENLEAF LANDSCAPING INV 88')).toBeTruthy();
  });

  // Runs LAST — it writes to the shared demo mock (the saved line's hash would make an
  // identical line in a later test read as a duplicate).
  it('a collapsed month\'s checked row still counts in the footer and saves', async () => {
    const onSaved = vi.fn();
    renderReview(twoMonths(), onSaved);
    await waitFor(() => expect(monthHeader('April 2026')).toBeTruthy());

    // April is collapsed, but its pre-checked $450 CAM expense is in the footer count.
    expect(document.querySelector('.stmt-footer').textContent).toMatch(/1 expense/);
    expect(document.querySelector('.stmt-footer').textContent).toContain('$450.00');

    // Save writes it even though its month is collapsed.
    fireEvent.click(screen.getByText('Save to ledger'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const applied = onSaved.mock.calls[0][0].import.applied;
    expect(applied.some((a) => a.kind === 'cam' && Math.round(Number(a.amount)) === 450)).toBe(true);
  });
});
