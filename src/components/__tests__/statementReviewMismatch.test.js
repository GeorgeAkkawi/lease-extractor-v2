// Render test for the rent-mismatch flow on the statement review (against the demo
// mock): a City Dental deposit that comes in SHORT of the month's projected rent →
// the "≠ projected" chip + a "Draft letter" action prefilled with the shortfall figures,
// money-in rows carry no "Always" tick (they're auto-learned), and saving a checked
// deposit teaches a payee rule that rides the import's `applied`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { currentYear } from '../../lib/format';

const Y = currentYear();

// A short City Dental deposit (paid the OLD 9,150 as 8,000) + one recognizable expense.
const parsed = () => ({
  transactions: [
    { date: `${Y}-04-05`, description: 'CHECK 1044 CITY DENTAL PC', amount: 8000, direction: 'in', balance: null, line: 1 },
    { date: `${Y}-04-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 2 },
  ],
  skippedLines: [],
  warnings: [],
});

function renderReview(onSaved = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview propertyId="prop-1" year={Y} fileName="apr.csv" parsed={parsed()} onCancel={() => {}} onSaved={onSaved} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const depRow = () => screen.getByText('CHECK 1044 CITY DENTAL PC').closest('tr');

beforeEach(() => cleanup());

describe('StatementReview — rent mismatch + auto-learn', () => {
  it('flags a short deposit tagged to a month, drafts the shortfall letter, and keeps money-in tick-free', async () => {
    renderReview();
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());

    // Money-in never shows an "Always" tick (auto-learned); the money-out expense does.
    expect(depRow().querySelectorAll('input[type=checkbox]')).toHaveLength(1); // include only
    const expRow = screen.getByText('GREENLEAF LANDSCAPING INV 88').closest('tr');
    expect(expRow.querySelectorAll('input[type=checkbox]')).toHaveLength(2); // include + Always

    // Tag the deposit to April (owed $9,150) → the mismatch chip + Draft letter appear.
    const monthSelect = depRow().querySelectorAll('select')[1]; // [Record as, For month]
    fireEvent.change(monthSelect, { target: { value: '4' } });
    await waitFor(() => expect(within(depRow()).getByText(/≠ projected \$9,150\.00 — short \$1,150\.00/)).toBeTruthy());

    // Draft the letter → the compose modal opens prefilled with the figures + contact.
    fireEvent.click(within(depRow()).getByText(/Draft letter/));
    await waitFor(() => expect(screen.getByText('Rent shortfall notice')).toBeTruthy());
    const body = document.querySelector('.invoice-text').value;
    expect(body).toContain('$9,150.00');
    expect(body).toContain('$8,000.00');
    expect(body).toContain('Dana Lee'); // the tenant contact from the lease
  });

  it('a checked deposit shows the "auto" hint and teaches a payee rule on save', async () => {
    const onSaved = vi.fn();
    renderReview(onSaved);
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());

    // Tag the month and include the deposit.
    fireEvent.change(depRow().querySelectorAll('select')[1], { target: { value: '4' } });
    fireEvent.click(depRow().querySelector('input[type=checkbox]'));
    // A checked tenant deposit is remembered automatically (no tick needed).
    await waitFor(() => expect(within(depRow()).getByText('auto')).toBeTruthy());
    // The footer counts the checked mismatch.
    expect(document.querySelector('.stmt-footer').textContent).toContain('≠ projected');

    // Save → the import learns the "CITY DENTAL PC" → City Dental rule (in `applied`).
    fireEvent.click(screen.getByText('Save to ledger'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const applied = onSaved.mock.calls[0][0].import.applied;
    expect(applied.some((a) => a.kind === 'rule' && a.pattern === 'CITY DENTAL PC' && a.lease_id === 'lease-2')).toBe(true);
  });
});
