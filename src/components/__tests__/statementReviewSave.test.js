// Render tests for the statement review's save path (against the demo mock), each
// locking one thing that let George's May statement import nine payments with no month
// on them at all — and the affordances that were missing when he tried to fix it by
// hand. A sibling of statementReviewMismatch/Escalation/Ui so those files stay untouched.
//
//  1. re-picking the tenant RE-DATES the line. The matcher's month was computed against
//     whoever it named; inheriting that answer for a different tenant is what saved the
//     nine untagged payments.
//  2. a line that would settle a month already recorded as paid says so and stays
//     unticked — back-filling old statements onto hand-marked months is how rent gets
//     recorded twice.
//  3. Save is never a silent grey button.
//  4. money out has a one-click ✕ Ignore.
//  5. the Always column never renders empty.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StatementReview from '../StatementReview';
import { saveImportRule, listImportRules, deleteImportRule } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

function renderReview(transactions, onSaved = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StatementReview
          propertyId="prop-1" year={Y} fileName="may.csv" accountHint="••4821"
          parsed={{ transactions, skippedLines: [], warnings: [] }}
          onCancel={() => {}} onSaved={onSaved}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// Match on the DESCRIPTION cell: a checked row also names the payee it will
// remember, so a bare text search finds the same wording twice.
const rowFor = (text) => Array.from(document.querySelectorAll('.stmt-table tbody tr'))
  .find((tr) => new RegExp(text).test(tr.querySelector('.stmt-desc')?.textContent || ''));

beforeEach(() => cleanup());
afterAll(async () => {
  for (const r of await listImportRules()) if (String(r.pattern).startsWith('ZZ')) await deleteImportRule(r.id);
});

describe('StatementReview — the month follows the statement', () => {
  it('re-picking the tenant re-dates the line instead of inheriting the wrong answer', async () => {
    // A remembered payee pointing at the WRONG tenant — exactly the state a boilerplate
    // pattern used to leave the ledger in.
    const rule = await saveImportRule({ property_id: 'prop-1', pattern: 'ZZGUSTAVO', target_kind: 'tenant', lease_id: 'lease-1' });
    // $109,800 — City Dental's WHOLE year in one payment, and nothing at all to Bright
    // Coffee, so the two tenants genuinely deserve different answers.
    renderReview([{ date: `${Y}-05-02`, description: 'ONLINE ACH DEBIT 9031521835 FROM ZZGUSTAVO', amount: 109800, direction: 'in', balance: null, line: 1 }]);
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());
    const row = screen.getByText('ONLINE ACH DEBIT 9031521835 FROM ZZGUSTAVO').closest('tr');
    const [pickSel, monthSel] = row.querySelectorAll('select');

    // The rule matched Bright Coffee, whose year is settled — nothing corroborates, so
    // the line is dated from the statement itself: May.
    expect(pickSel.value).toBe('lease:lease-1');
    await waitFor(() => expect(monthSel.value).toBe('5'));

    // Name the real tenant → the answer is recomputed for THEM: this is City Dental's
    // whole year, so it goes in untagged and the ledger spreads it. Inheriting the
    // previous tenant's answer is how a hand-corrected line saved with no month at all.
    fireEvent.change(pickSel, { target: { value: 'lease:lease-2' } });
    await waitFor(() => expect(row.querySelectorAll('select')[1].value).toBe(''));
    expect(within(row).getByText('covers several months')).toBeTruthy();

    // And a month typed by hand still wins over both.
    fireEvent.change(row.querySelectorAll('select')[1], { target: { value: '5' } });
    expect(row.querySelectorAll('select')[1].value).toBe('5');
    await deleteImportRule(rule.id);
  });

  it('warns before recording a month that is already paid, and leaves it unticked', async () => {
    // City Dental's January is already marked (a $9,150 tagged payment in the seed).
    // Back-filling January's real bank deposit on top would record the rent twice.
    renderReview([{ date: `${Y}-01-05`, description: 'CHECK 1044 CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 }]);
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());
    const row = rowFor('CHECK 1044 CITY DENTAL PC');
    await waitFor(() => expect(row.querySelectorAll('select')[1].value).toBe('1'));
    expect(within(row).getByText(/January is already recorded as paid/)).toBeTruthy();
    expect(row.querySelector('input[type=checkbox]').checked).toBe(false);
    expect(document.querySelector('.stmt-footer').textContent).toContain('already recorded as paid');

    // It's a warning, not a lock — the landlord can still tick it.
    fireEvent.click(row.querySelector('input[type=checkbox]'));
    await waitFor(() => expect(row.querySelector('input[type=checkbox]').checked).toBe(true));
  });
});

describe('StatementReview — the affordances around Save', () => {
  it('says what to do instead of greying Save out in silence', async () => {
    renderReview([{ date: `${Y}-05-02`, description: 'ZZUNKNOWN PAYEE 4412', amount: 1234.56, direction: 'in', balance: null, line: 1 }]);
    await waitFor(() => expect(screen.getByText(/Money in · 1/)).toBeTruthy());
    expect(screen.getByText(/Nothing is ticked yet/)).toBeTruthy();
    expect(screen.getByText('Save to ledger').disabled).toBe(true);
    // 🤖 reaches it — an unrecognized deposit is exactly what the helper is for.
    expect(screen.getByText(/Suggest tenants/)).toBeTruthy();
  });

  it('money out has a one-click ✕ Ignore that undoes itself', async () => {
    renderReview([{ date: `${Y}-05-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 1 }]);
    await waitFor(() => expect(screen.getByText(/Money out · 1/)).toBeTruthy());
    const row = () => rowFor('GREENLEAF LANDSCAPING INV 88');
    expect(row().className).not.toContain('stmt-off');

    fireEvent.click(within(row()).getByText('✕ Ignore'));
    await waitFor(() => expect(row().className).toContain('stmt-off'));
    expect(row().querySelectorAll('select')[0].value).toBe('ignore');

    fireEvent.click(within(row()).getByText('↩ Undo ignore'));
    await waitFor(() => expect(row().className).not.toContain('stmt-off'));
  });

  it('a line about to be recorded says which payee it will remember — and there is no second tick', async () => {
    renderReview([
      { date: `${Y}-05-02`, description: 'CHECK 1044 CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 },
      { date: `${Y}-05-03`, description: 'ZZUNKNOWN PAYEE 4412', amount: 1234.56, direction: 'in', balance: null, line: 2 },
      { date: `${Y}-05-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 3 },
    ]);
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    // Seven columns, one tick each: the "Always" column George couldn't make sense of
    // is gone, and remembering happens by saving.
    for (const tr of document.querySelectorAll('.stmt-table tbody tr')) {
      expect(tr.querySelectorAll('td')).toHaveLength(7);
      expect(tr.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    }
    // The recognized deposit is ticked, so it names what it teaches; a line nothing
    // recognizes teaches nothing and says nothing.
    expect(within(rowFor('CHECK 1044 CITY DENTAL PC')).getByText(/remembers “CITY DENTAL PC”/)).toBeTruthy();
    expect(within(rowFor('ZZUNKNOWN PAYEE 4412')).queryByText(/remembers/)).toBe(null);

    // An expense teaches its payee the same way — no extra column needed — and drops
    // the promise the moment it's left out of the import.
    expect(within(rowFor('GREENLEAF LANDSCAPING INV 88')).getByText(/remembers “GREENLEAF LANDSCAPING/)).toBeTruthy();
    fireEvent.click(rowFor('GREENLEAF LANDSCAPING INV 88').querySelector('input[type=checkbox]'));
    await waitFor(() => expect(within(rowFor('GREENLEAF LANDSCAPING INV 88')).queryByText(/remembers/)).toBe(null));
  });
});

describe('StatementReview — what gets remembered', () => {
  it('learns one payee per tenant, and refuses a pattern that matches two of them', async () => {
    const onSaved = (res) => { onSaved.res = res; };
    renderReview([
      // Two tenants, one shared piece of bank wording. Their own names are distinct.
      { date: `${Y}-03-02`, description: 'ONLINE ACH DEBIT 111 FROM CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 1 },
      { date: `${Y}-03-03`, description: 'ONLINE ACH DEBIT 222 FROM BRIGHT COFFEE', amount: 6500, direction: 'in', balance: null, line: 2 },
    ], onSaved);
    await waitFor(() => expect(screen.getByText(/Money in · 2/)).toBeTruthy());
    // Tick both.
    document.querySelectorAll('.stmt-table tbody input[type=checkbox]').forEach((cb) => { if (!cb.checked) fireEvent.click(cb); });
    await waitFor(() => expect(screen.getByText('Save to ledger').disabled).toBe(false));

    fireEvent.click(screen.getByText('Save to ledger'));
    await waitFor(() => expect(onSaved.res).toBeTruthy());
    const learned = onSaved.res.import.applied.filter((a) => a.kind === 'rule').map((a) => a.pattern);
    // The payee, not the rail — and one rule each, not one rule swallowing both.
    expect(learned).toContain('CITY DENTAL PC');
    expect(learned).toContain('BRIGHT COFFEE');
    expect(learned).not.toContain('ONLINE ACH DEBIT');
    expect(new Set(learned).size).toBe(learned.length);
  });
});
