// The flag George asked for, driven through the real schedule editor against the demo mock.
//
// George, 2026-08-17: "if this happens it should flag and tell the user that number is off
// and have them choose what theyd like to do just for the sake of the software not flagging
// it every time."
//
// The arithmetic and the "keep both" key are pinned in lib/__tests__/duplicateRentSteps.test.js.
// What this adds is what only the component can show: the flag names both figures and says
// WHY they differ, keeping one really deletes the other, and "keep both" really stops it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EscalationScheduleEditor from '../EscalationScheduleEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import { listEscalations, listAlertStates } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';

// lease-3, whose seeded step is already applied — a second step on the SAME date is what
// the fourth addendum did to the beauty and barber shop lease, four cents apart.
const LEASE = { id: 'lease-3', property_id: 'prop-2', base_rent: 31801, lease_termination_date: '2030-05-31' };
const DATE = '2025-06-01';

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider><EscalationScheduleEditor lease={LEASE} /></ConfirmProvider>
    </QueryClientProvider>
  );
};

const pair = [
  { id: 'dup-monthly', owner_id: 'demo', lease_id: LEASE.id, effective_date: DATE, escalation_type: 'manual', escalation_value: null, new_base_rent: 31800.96, status: 'applied', applied_at: DATE },
  { id: 'dup-annual', owner_id: 'demo', lease_id: LEASE.id, effective_date: DATE, escalation_type: 'manual', escalation_value: null, new_base_rent: 31801, status: 'applied', applied_at: DATE },
];

beforeEach(async () => {
  cleanup();
  for (const r of pair) await supabase.from('rent_escalations').insert(r);
});
afterEach(async () => {
  for (const r of pair) await supabase.from('rent_escalations').delete().eq('id', r.id);
  for (const s of await listAlertStates()) {
    if (String(s.alert_key).startsWith('rent_dup:')) await supabase.from('alert_states').delete().eq('alert_key', s.alert_key);
  }
});

const flag = () => waitFor(() => {
  const el = document.querySelector('.dup-flag');
  expect(el).toBeTruthy();
  return el;
});

describe('Two rent steps on one date get named, not silently tolerated', () => {
  it('states both figures and the gap between them', async () => {
    wrap();
    const el = await flag();
    expect(el.textContent).toMatch(/Two rent steps on June 1, 2025/);
    expect(el.textContent).toMatch(/\$31,801\.00 and \$31,800\.96/);
    expect(el.textContent).toMatch(/\$0\.04 apart/);
  });

  it('explains it as one rent rounded two ways, in the month the lease actually printed', async () => {
    // Not "four cents apart" — "both work out to $2,650.08 a month". That is the sentence
    // that lets a landlord decide in one read instead of going back to the document.
    const el = await (wrap(), flag());
    expect(el.textContent).toMatch(/both work out to \$2,650\.08 a month/);
  });

  it('marks the rows it means, so the flag and the table agree', async () => {
    wrap();
    await flag();
    expect(screen.getAllByText('duplicate').length).toBeGreaterThanOrEqual(2);
  });
});

describe('The three answers', () => {
  it('keeping one figure removes the other, and says so before it does', async () => {
    wrap();
    await flag();
    fireEvent.click(screen.getByRole('button', { name: 'Keep $31,801.00' }));

    // Deleting a rent step goes through the same confirm a single-step delete does — and
    // it names the figure that is about to go, not just "the other one".
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/\$31,800\.96/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep $31,801.00' }));

    await waitFor(async () => {
      const left = (await listEscalations(LEASE.id)).filter((e) => e.effective_date === DATE);
      expect(left).toHaveLength(1);
      expect(Number(left[0].new_base_rent)).toBe(31801);
    }, { timeout: 3000 });
  });

  it('“keep both” stores the decision and the flag goes for good', async () => {
    wrap();
    await flag();
    fireEvent.click(screen.getByText('Keep both — stop asking'));

    await waitFor(() => expect(document.querySelector('.dup-flag')).toBeNull());
    // Server-side, not this browser's localStorage — so it follows the landlord.
    const states = await listAlertStates();
    expect(states.some((s) => s.alert_key === `rent_dup:${LEASE.id}:${DATE}` && s.dismissed)).toBe(true);
    // And both steps are still there: "keep both" keeps both.
    expect((await listEscalations(LEASE.id)).filter((e) => e.effective_date === DATE)).toHaveLength(2);
  });
});

describe('An ordinary schedule is left alone', () => {
  it('raises nothing when every date carries one step', async () => {
    for (const r of pair) await supabase.from('rent_escalations').delete().eq('id', r.id);
    wrap();
    await waitFor(() => expect(document.querySelector('table')).toBeTruthy());
    expect(document.querySelector('.dup-flag')).toBeNull();
    expect(screen.queryByText('duplicate')).toBeNull();
  });
});
