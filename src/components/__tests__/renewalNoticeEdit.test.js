// Editing a renewal option's notice deadline in place, driven through the real table
// against the demo mock.
//
// George, 2026-07-30: "for the renewal tab make sure i can click into notice by and
// change the duration to something specific like how many months before"
//
// The pure rules are pinned in lib/__tests__/renewalNoticeLead.test.js. What these add
// is the part only the real component can show: the cell is genuinely clickable, what
// you type is what gets stored, and a period that has moved says so on the row.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RenewalOptionsEditor from '../RenewalOptionsEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import { listRenewals } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';

// City Dental, whose seeded option carries the rule as well as the date: notice six
// months before a term ending 2026-05-31, which is 2025-11-30.
const LEASE = { id: 'lease-2', property_id: 'prop-1', tenant_name: 'City Dental', base_rent: 84000, lease_start: '2025-06-01', lease_termination_date: '2026-05-31' };
const SEED = { notice_by_date: '2025-11-30', notice_lead_n: 6, notice_lead_unit: 'months', status: 'pending', applied_at: null };

const renderEditor = (lease = LEASE) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <RenewalOptionsEditor leaseId={lease.id} lease={lease} escalations={[]} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
};

const restore = async () => { await supabase.from('renewal_options').update(SEED).eq('id', 'ren-1'); };
beforeEach(async () => { cleanup(); await restore(); });
afterEach(restore);

// The deadline cell — the only button in the row whose label is a date.
const noticeCell = () => waitFor(() => {
  const el = document.querySelector('.notice-cell');
  expect(el).toBeTruthy();
  return el;
});
const editorRow = () => waitFor(() => {
  const el = document.querySelector('.notice-by');
  expect(el).toBeTruthy();
  return el.closest('tr');
});

describe('The deadline says the rule, not just the date', () => {
  it('shows what the lease states alongside the date it works out to', async () => {
    renderEditor();
    const cell = await noticeCell();
    expect(cell.textContent).toMatch(/November 30, 2025/);
    expect(cell.textContent).toMatch(/6 months before/);
  });

  it('opens on the rule it was set from, not on a bare date', async () => {
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();
    expect(within(row).getByLabelText('How the notice deadline is stated').value).toBe('months');
    expect(within(row).getByLabelText('How far ahead notice is due').value).toBe('6');
    // And it names what it counts back from — the thing a bare date can never say.
    expect(row.querySelector('.notice-by-read').textContent).toMatch(/counted back from May 31, 2026/);
  });
});

describe('Changing the duration', () => {
  it('works the date out from what you type, and stores both', async () => {
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();
    fireEvent.change(within(row).getByLabelText('How the notice deadline is stated'), { target: { value: 'days' } });
    fireEvent.change(within(row).getByLabelText('How far ahead notice is due'), { target: { value: '180' } });

    // Shown before it's saved — 180 days back from May 31, 2026.
    await waitFor(() => expect(row.querySelector('.notice-by-read').textContent).toMatch(/December 2, 2025/));
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const [opt] = await listRenewals('lease-2');
      expect(opt.notice_by_date).toBe('2025-12-02');
      expect(opt.notice_lead_n).toBe(180);
      expect(opt.notice_lead_unit).toBe('days');
    });
    expect((await noticeCell()).textContent).toMatch(/180 days before/);
  });

  it('still takes a plain date, and then carries no rule to re-date it by', async () => {
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();
    fireEvent.change(within(row).getByLabelText('How the notice deadline is stated'), { target: { value: 'date' } });
    fireEvent.change(within(row).getByLabelText('Notice due on'), { target: { value: '2026-01-15' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const [opt] = await listRenewals('lease-2');
      expect(opt.notice_by_date).toBe('2026-01-15');
      expect(opt.notice_lead_n).toBeNull();
      expect(opt.notice_lead_unit).toBeNull();
    });
  });

  it('says plainly when Save would clear the deadline instead of setting one', async () => {
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();
    fireEvent.change(within(row).getByLabelText('How far ahead notice is due'), { target: { value: '' } });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Clear deadline' })).toBeTruthy());
  });
});

// George, 2026-07-30: "theres a default set by the settings so make sure thats the
// default set in the notice by which can be changed by clicking in for specific tenants."
describe('An option with no deadline of its own', () => {
  // Strip the seeded rule so this option is in the state four of George's live options
  // are in: pending, with nothing in Notice by.
  const clearNotice = () => supabase.from('renewal_options')
    .update({ notice_by_date: null, notice_lead_n: null, notice_lead_unit: null }).eq('id', 'ren-1');

  it('says what the default is, without pretending it is stored', async () => {
    await clearNotice();
    renderEditor();
    const cell = await noticeCell();
    // Nothing on file — so the cell still asks to be set, and the sub-line names the
    // default rather than showing a date the bell would know nothing about.
    expect(cell.textContent).toMatch(/＋ set/);
    expect(cell.textContent).toMatch(/default 6 months before/);
    expect(cell.textContent).not.toMatch(/2025/);
  });

  it('opens pre-filled from Settings, with the date already worked out', async () => {
    await clearNotice();
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();

    // The shipped renewal lead is 183 days, which a lease would state as six months.
    expect(within(row).getByLabelText('How the notice deadline is stated').value).toBe('months');
    expect(within(row).getByLabelText('How far ahead notice is due').value).toBe('6');
    expect(row.querySelector('.notice-by-read').textContent).toMatch(/November 30, 2025/);
    // …and it says where that figure came from, so it doesn't read as the lease's.
    expect(row.querySelector('.notice-by-default').textContent).toMatch(/Settings/);

    // Still only a pre-fill: nothing is written until Save.
    expect((await listRenewals('lease-2'))[0].notice_by_date).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      const [opt] = await listRenewals('lease-2');
      expect(opt.notice_by_date).toBe('2025-11-30');
      expect(opt.notice_lead_n).toBe(6);
    });
  });

  it('can be changed for this tenant without touching the default', async () => {
    await clearNotice();
    renderEditor();
    fireEvent.click(await noticeCell());
    const row = await editorRow();
    fireEvent.change(within(row).getByLabelText('How the notice deadline is stated'), { target: { value: 'days' } });
    fireEvent.change(within(row).getByLabelText('How far ahead notice is due'), { target: { value: '180' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const [opt] = await listRenewals('lease-2');
      expect(opt.notice_lead_n).toBe(180);
      expect(opt.notice_lead_unit).toBe('days');
    });
    // The saved rule replaces the default on the row — the default is a starting point,
    // not something the option keeps deferring to.
    const cell = await noticeCell();
    expect(cell.textContent).toMatch(/180 days before/);
    expect(cell.textContent).not.toMatch(/default/);
  });
});

describe('When the period moves under a stored rule', () => {
  it('flags the row rather than leaving a date that no longer means what the lease says', async () => {
    // Same option, but the lease term has since been carried to 2029 by an addendum.
    renderEditor({ ...LEASE, lease_termination_date: '2029-05-31' });
    const cell = await noticeCell();
    expect(cell.textContent).toMatch(/November 30, 2025/);          // still what's stored
    expect(cell.textContent).toMatch(/period moved → November 30, 2028/);

    // One click in, one click Save — the rule is unchanged, the date follows it.
    fireEvent.click(cell);
    const row = await editorRow();
    expect(within(row).getByLabelText('How far ahead notice is due').value).toBe('6');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await listRenewals('lease-2'))[0].notice_by_date).toBe('2028-11-30'));
    await waitFor(() => expect(document.querySelector('.notice-drift')).toBeNull());
  });
});
