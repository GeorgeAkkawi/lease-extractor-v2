// The Overview's alert feed, rendered the way the browser renders it.
//
// George, 2026-07-30: "fix notifications formatting to something where i dont have to
// scroll a lot to see all" → one column per notification type, compact rows, empty
// columns still showing. groupFeed/rowSubject are pinned in notifyTypes.test.js; this is
// the wiring, plus the two invariants compaction could quietly have broken: the countdown
// must still be absent on a weight-based alert, and a row carrying a QUESTION must keep
// its buttons visible rather than hiding them behind a hover.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../DashboardPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { NOTIFY_COLUMNS } from '../../lib/notifyTypes';
import { supabase } from '../../lib/supabaseClient';

const NOTIF = {
  id: 'notif-board-test',
  lease_id: 'lease-2', property_id: 'prop-1', corporation_id: 'corp-1',
  kind: 'renewal_decision',
  title: 'Is City Dental renewing?',
  body: 'Option 1 — 5-yr extension at $90,000.',
  read: false, created_at: new Date().toISOString(),
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

const colFor = (container, label) =>
  [...container.querySelectorAll('.notif-col')].find((n) => n.querySelector('.notif-col-head').textContent.includes(label));

beforeEach(() => cleanup());

describe('Overview — the notification board', () => {
  it('renders every registered column, empty ones included, reading "All clear"', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(container.querySelector('.notif-board')).toBeTruthy());
    // George's explicit pick: the headings always sit in the same place, so the board's
    // shape doesn't move as the week goes on.
    NOTIFY_COLUMNS.forEach((c) => expect(colFor(container, c.label)).toBeTruthy());
    const empty = [...container.querySelectorAll('.notif-col')].filter((n) => !n.querySelector('.nrow'));
    empty.forEach((n) => expect(n.textContent).toMatch(/All clear/));
  });

  it('shows one compact line per row — the subject, not the whole title', async () => {
    const { container } = renderDash();
    const row = await waitFor(() => {
      const el = container.querySelector('.nrow');
      expect(el).toBeTruthy();
      return el;
    });
    const subject = row.querySelector('.nrow-subject').textContent;
    // The column heading already says what KIND of thing it is, so the row doesn't repeat
    // it — that repetition is what made the old rows three lines tall.
    expect(subject).not.toMatch(/^(Rent escalation|Lease ending|Renewal notice|Contract ending) —/);
    expect(subject.length).toBeGreaterThan(0);
    // Everything the compact row dropped is still reachable, in the tooltip.
    expect(row.getAttribute('title')).toContain(subject);
  });

  it('files a lease-ending alert under Lease endings', async () => {
    const { container } = renderDash();
    // The demo seed's City Dental term ended in May and it's still in place — a holdover,
    // which is a termination-focus alert.
    const col = await waitFor(() => {
      const el = colFor(container, 'Lease endings');
      expect(el.querySelector('.nrow')).toBeTruthy();
      return el;
    });
    expect(within(col).getByText('City Dental')).toBeTruthy();
  });

  it('counts its rows in the column head', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(container.querySelector('.notif-count')).toBeTruthy());
    [...container.querySelectorAll('.notif-col')].forEach((n) => {
      const badge = n.querySelector('.notif-count');
      const rows = n.querySelectorAll('.nrow').length;
      if (rows === 0) expect(badge).toBeNull();
      else expect(Number(badge.textContent)).toBe(rows);
    });
  });
});

describe('Overview — what compaction must NOT break', () => {
  afterEach(async () => { await supabase.from('notifications').delete().eq('id', NOTIF.id); });

  it('keeps a decision’s Yes/No visible instead of hiding it behind a hover', async () => {
    await supabase.from('notifications').insert({ ...NOTIF });
    const { container } = renderDash();
    const row = await waitFor(() => {
      const el = [...container.querySelectorAll('.nrow')]
        .find((n) => (n.getAttribute('title') || '').includes('Is City Dental renewing?'));
      expect(el).toBeTruthy();
      return el;
    });
    // A question waiting on an answer opts out of the hover-reveal.
    expect(row.classList.contains('has-decision')).toBe(true);
    expect(within(row).getByText(/Yes — apply renewal/)).toBeTruthy();
    expect(within(row).getByText(/No — not renewing/)).toBeTruthy();
  });

  it('still shows no countdown on an alert whose days value is a sort weight', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(container.querySelector('.notif-board')).toBeTruthy());
    // Every rendered chip is a real countdown; a weight-based alert renders none at all.
    [...container.querySelectorAll('.nrow')].forEach((row) => {
      const chip = row.querySelector('.alert-days');
      if (chip) expect(chip.textContent).toMatch(/^\d+d( over)?$/);
    });
  });
});
