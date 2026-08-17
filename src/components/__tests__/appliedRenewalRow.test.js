// George, 2026-08-17, on the beauty and barber shop lease: "for beatuy and barber shop
// what is the new rent number in the renewal option referring too (19,386)? i think that
// renewal option tab is just way off in general." — plus "in the renewal options drop down
// in a specific lease i cant change the notice by deadline."
//
// All three faults were on the same row, and all three were about an option whose status
// is `applied`. The shape below is that lease's real one: a 2004 lease, one option applied
// 2008-09-01 for 60 months at $19,386, on a term two later addendums carried to 2030-05-31,
// against a base rent that is $31,801 today.
//
// The window arithmetic is pinned in lib/__tests__/optionWindows.test.js. What this adds is
// what only the real table can show: the row says what it can't know, the rent carries its
// tense, and the deadline is genuinely clickable.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RenewalOptionsEditor from '../RenewalOptionsEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';

const LEASE = {
  id: 'lease-2', property_id: 'prop-1', tenant_name: 'beauty and barber shop',
  base_rent: 31801, lease_start: '2004-01-01', lease_termination_date: '2030-05-31',
};
// The step that option actually booked — $19,386, effective the January after it was applied.
const ESCALATIONS = [
  { id: 'x1', effective_date: '2009-01-01', new_base_rent: 19386, status: 'applied' },
  { id: 'x2', effective_date: '2020-06-01', new_base_rent: 24200, status: 'applied' },
  { id: 'x3', effective_date: '2025-06-01', new_base_rent: 31801, status: 'applied' },
];

const APPLIED = {
  option_label: 'First Option to Renew', term_months: 60, notice_by_date: '2008-09-01',
  notice_lead_n: null, notice_lead_unit: null, new_rent: 19386, annual_escalation_pct: null,
  status: 'applied', applied_at: '2008-09-01 12:00:00+00',
};
const SEED = {
  option_label: 'Option 1', term_months: 60, notice_by_date: '2025-11-30',
  notice_lead_n: 6, notice_lead_unit: 'months', new_rent: null, annual_escalation_pct: null,
  status: 'pending', applied_at: null,
};

const renderEditor = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <RenewalOptionsEditor leaseId={LEASE.id} lease={LEASE} escalations={ESCALATIONS} estimateBase={31801} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
};

beforeEach(async () => { cleanup(); await supabase.from('renewal_options').update(APPLIED).eq('id', 'ren-1'); });
afterEach(async () => { await supabase.from('renewal_options').update(SEED).eq('id', 'ren-1'); });

const row = () => waitFor(() => {
  const el = document.querySelector('.opt-covers');
  expect(el).toBeTruthy();
  return el.closest('tr');
});

describe('An applied option stops printing a period it cannot know', () => {
  it('does NOT date it as the years a later addendum bought', async () => {
    renderEditor();
    await row();
    // Counting 60 months back from 2030-05-31 gives Jun 1 2025 → May 31 2030. That is the
    // fourth addendum's period, and it must not appear on an option applied in 2008.
    expect(screen.queryByText(/June 1, 2025 → May 31, 2030/)).toBeNull();
  });

  it('shows the stated length instead, and says why there are no dates', async () => {
    renderEditor();
    const covers = (await row()).querySelector('.opt-covers');
    expect(covers.textContent).toMatch(/60 mo \(5 yr\)/);
    expect(covers.textContent).toMatch(/the term has been extended since/);
  });
});

describe('The rent an applied option quotes carries its tense', () => {
  it('says when $19,386 took effect and what the rent is now', async () => {
    renderEditor();
    await row();
    expect(screen.getByText('$19,386')).toBeTruthy();
    // The date is the real rent step carrying that figure, not a guess.
    expect(screen.getByText(/took effect January 1, 2009/)).toBeTruthy();
    expect(screen.getByText(/today \$31,801/)).toBeTruthy();
  });

  it('still answers when no rent step matches, rather than inventing a date', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <RenewalOptionsEditor leaseId={LEASE.id} lease={LEASE} escalations={[]} estimateBase={31801} />
        </ConfirmProvider>
      </QueryClientProvider>
    );
    await row();
    expect(screen.getByText(/the rent it set/)).toBeTruthy();
    expect(screen.queryByText(/took effect/)).toBeNull();
  });
});

describe('The deadline on a settled option is still correctable', () => {
  it('is a button, not plain text', async () => {
    renderEditor();
    await row();
    const cell = document.querySelector('.notice-cell');
    expect(cell).toBeTruthy();
    expect(cell.textContent).toMatch(/September 1, 2008/);
  });

  it('opens on a plain date — there is no live period to count a duration back from', async () => {
    renderEditor();
    await row();
    fireEvent.click(document.querySelector('.notice-cell'));
    const field = await waitFor(() => {
      const el = document.querySelector('.notice-by');
      expect(el).toBeTruthy();
      return el;
    });
    expect(field.querySelector('input[type="date"]')).toBeTruthy();
    // The months/days/date chooser is hidden rather than offering a rule that resolves to
    // nothing and would silently clear the date on save.
    expect(field.querySelector('select')).toBeNull();
    expect(screen.getByText(/correcting it leaves the option applied/)).toBeTruthy();
  });

  it('stores the corrected date and leaves the option applied', async () => {
    renderEditor();
    await row();
    fireEvent.click(document.querySelector('.notice-cell'));
    const input = await waitFor(() => {
      const el = document.querySelector('.notice-by input[type="date"]');
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.change(input, { target: { value: '2008-11-01' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/November 1, 2008/)).toBeTruthy());
    const [stored] = (await supabase.from('renewal_options').select('*').eq('id', 'ren-1')).data;
    expect(stored.notice_by_date).toBe('2008-11-01');
    expect(stored.status).toBe('applied');
    // A bare date carries no rule — nothing should ever re-date it.
    expect(stored.notice_lead_n).toBeNull();
  });
});
