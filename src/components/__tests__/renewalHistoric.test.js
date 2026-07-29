// The "Already renewed" button on a lapsed renewal option — driven through the real
// RenewalOptionsEditor against the demo mock, because the button only exists for a
// LAPSED option and its whole value is what it doesn't write.
//
// The lease shapes below are George's live one (2026-07-29): the demo's ren-1 (notice by
// 2025-11-30) hung on a term running to 2030 reads 'notice_passed' — a notice window that
// belonged to a term the lease has since been extended past, which is exactly the
// beauty-and-barber case. Pulling the term end back inside 18 months of the notice makes
// the same option a live decision again.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RenewalOptionsEditor from '../RenewalOptionsEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import { listRenewals, getLease, listHistoryEvents } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';

const BASE = { id: 'lease-2', property_id: 'prop-1', tenant_name: 'City Dental', base_rent: 84000, lease_start: '2025-06-01' };
const STALE = { ...BASE, lease_termination_date: '2030-05-31' }; // notice sits >18mo before the end
const LIVE = { ...BASE, lease_termination_date: '2027-03-31' };  // notice sits inside the window

function renderEditor(lease = STALE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <RenewalOptionsEditor leaseId={lease.id} lease={lease} escalations={[]} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// The option row only exists once its query resolves — wait on the label, never on a word
// that also appears in the panel's static help text.
const awaitRow = () => screen.findByText('Option 1');

beforeEach(() => cleanup());
afterEach(async () => {
  await supabase.from('renewal_options').update({ status: 'pending', applied_at: null }).eq('id', 'ren-1');
  await supabase.from('history_events').delete().eq('type', 'renewal_confirmed');
});

describe('Already renewed — the third answer a lapsed option needs', () => {
  it('records the exercise on the date given, and leaves the lease alone', async () => {
    const before = await getLease('lease-2');
    renderEditor();
    await awaitRow();

    fireEvent.click(screen.getByRole('button', { name: 'Already renewed' }));

    // The date is the point of the row — it's a history entry, not a decision. It arrives
    // prefilled from the option's own notice date so the common case is one more click.
    const dateInput = await screen.findByLabelText(/Renewed on/i);
    expect(dateInput.value).toBe('2025-11-30');
    fireEvent.change(dateInput, { target: { value: '2008-09-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record as renewed' }));

    // The dialog has to say what it will NOT do — that's the whole reason this path exists.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/are NOT changed/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record as renewed' }));

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    const opt = (await listRenewals('lease-2')).find((r) => r.id === 'ren-1');
    expect(opt.status).toBe('applied');
    expect(String(opt.applied_at).slice(0, 10)).toBe('2008-09-01');

    const after = await getLease('lease-2');
    expect(after.base_rent).toBe(before.base_rent);
    expect(after.lease_termination_date).toBe(before.lease_termination_date);

    const ev = (await listHistoryEvents('prop-1')).find((e) => e.type === 'renewal_confirmed');
    expect(ev.event_date).toBe('2008-09-01');
  });

  it('backs out cleanly — Cancel on the row writes nothing', async () => {
    renderEditor();
    await awaitRow();
    fireEvent.click(screen.getByRole('button', { name: 'Already renewed' }));
    await screen.findByLabelText(/Renewed on/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText(/Renewed on/i)).toBeNull());
    expect((await listRenewals('lease-2')).find((r) => r.id === 'ren-1').status).toBe('pending');
  });

  it('is offered ONLY on a lapsed option — a live one is a real decision, not history', async () => {
    renderEditor(LIVE);
    await awaitRow();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Already renewed' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeTruthy();
  });

  it('points at it from the lapsed banner, where the landlord meets the problem', async () => {
    renderEditor();
    await awaitRow();
    const banner = [...document.querySelectorAll('.note-msg')].find((n) => /leftover record/i.test(n.textContent));
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/Already renewed/);
    expect(banner.textContent).toMatch(/without touching the term or rent/i);
  });
});
