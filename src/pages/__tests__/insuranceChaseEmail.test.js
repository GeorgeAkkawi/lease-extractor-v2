// End to end on the Overview, against the demo mock: a certificate asked for and never
// sent raises the "Insurance not received" reminder, that reminder now carries a ✉, and
// clicking it opens the SECOND-request letter — not a copy of the first one.
//
// This is the piece that was missing rather than broken: draftAlertEmail had built an
// email for insurance_chase since 2026-07-09, but the page's alertCanEmail never returned
// true for that focus, so the button could not render (flagged in CLAUDE.md 2026-07-26).
// The test therefore drives the real button, not the helper — a helper test would have
// passed the whole time the feature was unreachable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../DashboardPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';

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

// The demo seeds one insurance_requested event, dated recently and pointed at Bright
// Coffee — whose certificate was then saved AFTER the request, which is precisely the
// "they responded" case the chase-up must stay quiet about. So the test moves it to City
// Dental (certificate on file since last year, never updated since) and backdates it past
// the 21-day lead, then puts it back. Moving the SEED instead would make the demo nag on
// every load, which it shouldn't.
const ORIGINAL = {};
const backdate = async (days) => {
  const { data } = await supabase.from('history_events').select('*').eq('type', 'insurance_requested');
  const row = (data || [])[0];
  ORIGINAL.row = { ...row };
  const d = new Date(); d.setDate(d.getDate() - days);
  const iso = d.toISOString().slice(0, 10);
  await supabase.from('history_events')
    .update({ event_date: iso, created_at: iso, lease_id: 'lease-2', tenant_name: 'City Dental' })
    .eq('id', row.id);
  return row;
};

// A compact feed row shows only its subject ("City Dental"); the full title, who/where,
// detail and date all live in the row's title attribute, since the column heading already
// says what KIND of thing it is. So match against both.
const rowText = (el) => `${el.getAttribute('title') || ''} ${el.textContent}`.toLowerCase();

beforeEach(() => cleanup());
afterEach(async () => {
  if (ORIGINAL.row) {
    const o = ORIGINAL.row;
    await supabase.from('history_events')
      .update({ event_date: o.event_date, created_at: o.created_at, lease_id: o.lease_id, tenant_name: o.tenant_name })
      .eq('id', o.id);
    ORIGINAL.row = null;
  }
});

describe('Insurance not received → a second-request letter', () => {
  it('raises the reminder, gives it a ✉, and drafts the follow-up', async () => {
    await backdate(40);
    const { container } = renderDash();

    const row = await waitFor(() => {
      const el = [...container.querySelectorAll('.callout')].find((n) => rowText(n).includes('insurance not received'));
      expect(el).toBeTruthy();
      return el;
    });
    // It's a standing problem with no deadline — no invented countdown.
    expect(row.querySelector('.alert-days')).toBeNull();

    // The button that could not previously exist.
    const mail = row.querySelector('button[aria-label="Email reminder"]');
    expect(mail).toBeTruthy();
    fireEvent.click(mail);

    const body = await waitFor(() => {
      const t = document.querySelector('textarea');
      expect(t && /second request/i.test(t.value)).toBe(true);
      return t;
    });
    const text = body.value;

    // Its own letter: says it's the second ask, dates the first, and stays courteous.
    expect(text).toContain('This is our second request.');
    expect(text).toContain('kindly ask');
    expect(text).toMatch(/Dear /);
    expect(text.match(/Sincerely,/g)).toHaveLength(1);
    // Never the first letter's opening, which would read as though we'd forgotten.
    expect(text).not.toContain('To keep our records current');
  });

  it('stays silent while the request is still recent — no chase, no button', async () => {
    await backdate(3);
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Alerts & notifications')).toBeTruthy());
    await waitFor(() => {
      expect([...container.querySelectorAll('.callout')]
        .some((n) => rowText(n).includes('insurance not received'))).toBe(false);
    });
  });
});
