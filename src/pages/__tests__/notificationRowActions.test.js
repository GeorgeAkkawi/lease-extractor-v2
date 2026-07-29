// A stored notification carries the SAME controls as every other row in the Overview
// feed: ✉ · remind me later · ✕.
//
// It didn't. A computed alert had that column; a notification had a wordy
// "✉ View / send tenant email" link buried in its body and no snooze at all — so two rows
// asking for the same kind of decision (the "Is X renewing?" prompt sitting beside a
// renewal-notice alert) read as different kinds of thing. George, 2026-07-29: "make sure
// its just the email emoticon and add a snooze button for those types."
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../DashboardPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { listAlertStates } from '../../lib/api';
import { notificationKey } from '../../lib/alerts';
import { supabase } from '../../lib/supabaseClient';

const NOTIF = {
  id: 'notif-row-test',
  lease_id: 'lease-2',
  property_id: 'prop-1',
  corporation_id: 'corp-1',
  kind: 'renewal_decision',
  title: 'Is City Dental renewing?',
  body: 'Option 1 — 5-yr extension at $90,000.',
  email_to: 'billing@citydental.example',
  email_subject: 'Your renewal is coming up',
  email_body: 'Dear City Dental,\n\nYour renewal option…\n\nSincerely,',
  read: false,
  created_at: new Date().toISOString(),
};

function renderDash() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <DashboardPage />
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const rowFor = (container, text) =>
  [...container.querySelectorAll('.callout')].find((n) => n.textContent.includes(text));

beforeEach(async () => {
  cleanup();
  await supabase.from('notifications').insert({ ...NOTIF });
});
afterEach(async () => {
  await supabase.from('notifications').delete().eq('id', NOTIF.id);
  await supabase.from('alert_states').delete().eq('alert_key', notificationKey(NOTIF));
});

describe('Overview — a stored notification is formatted like every other row', () => {
  it('carries the ✉ icon button, not the old wordy link', async () => {
    const { container } = renderDash();
    const row = await waitFor(() => {
      const el = rowFor(container, 'Is City Dental renewing?');
      expect(el).toBeTruthy();
      return el;
    });

    expect(within(row).getByRole('button', { name: 'Email reminder' }).textContent).toBe('✉');
    expect(screen.queryByText(/View \/ send tenant email/)).toBeNull();
    // The Yes/No decision itself is untouched — this was a formatting fix, not a rewrite.
    expect(within(row).getByText(/Yes — apply renewal/)).toBeTruthy();
  });

  it('has a remind-me-later button, and using it takes the row off the feed', async () => {
    const { container } = renderDash();
    const row = await waitFor(() => {
      const el = rowFor(container, 'Is City Dental renewing?');
      expect(el).toBeTruthy();
      return el;
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Remind me later' }));
    fireEvent.click(await screen.findByRole('button', { name: 'In 1 week' }));

    // Gone from the feed…
    await waitFor(() => expect(rowFor(container, 'Is City Dental renewing?')).toBeFalsy());
    // …but NOT deleted — a snooze defers a decision, it doesn't answer it.
    const still = await supabase.from('notifications').select('*').eq('id', NOTIF.id);
    expect((still.data || []).length).toBe(1);
    // Stored server-side under its own namespace, so it syncs across devices like an alert's.
    const state = (await listAlertStates()).find((s) => s.alert_key === notificationKey(NOTIF));
    expect(new Date(state.snoozed_until).getTime()).toBeGreaterThan(Date.now());
  });

  it('opens the tenant email from the ✉, exactly as the alerts do', async () => {
    const { container } = renderDash();
    const row = await waitFor(() => {
      const el = rowFor(container, 'Is City Dental renewing?');
      expect(el).toBeTruthy();
      return el;
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Email reminder' }));
    await waitFor(() => {
      const t = document.querySelector('textarea');
      expect(t && /Your renewal option/.test(t.value)).toBe(true);
    });
  });
});
