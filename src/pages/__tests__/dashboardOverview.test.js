// Render smoke test for the two Overview additions: the "Portfolio at a glance" chart
// band and the urgency visuals inside the existing alerts panel. Mounts the REAL
// DashboardPage against the demo mock, so a crash, a missing field or a broken widget
// gate surfaces here rather than in the browser.
//
// One jsdom caveat drives every assertion below: recharts' ResponsiveContainer measures
// its parent, and in jsdom every element is 0×0 — so no SVG is ever drawn. Assert the
// panel titles and legends (real DOM, rendered regardless), never chart geometry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../DashboardPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { setHiddenWidgets, listPayments } from '../../lib/api';
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

beforeEach(() => cleanup());
afterEach(async () => { await setHiddenWidgets([]); });

describe('Overview — portfolio charts', () => {
  it('renders the four panels drawn from the seeded portfolio', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Where the rent comes from')).toBeTruthy());
    expect(screen.getByText('Space leased')).toBeTruthy();
    expect(screen.getByText('Rent coming up for renewal')).toBeTruthy();
    // The panel has to say what a bar is, not just what it's called: City Dental's term
    // ended in May and it's still in place, so the demo always carries a "Now" bucket —
    // and the foot has to explain it rather than leave a bar labelled "Now" to guesswork.
    expect(screen.getByText(/already past its end date/)).toBeTruthy();
    expect(screen.getByText('What each property keeps')).toBeTruthy();
    // The donut's centre caption — and now the ONLY place the rent roll is stated, since
    // the metric card that repeated it came off the page.
    expect(screen.getAllByText('Annual rent roll').length).toBe(1);
    expect(screen.getAllByText(/Maple Plaza/).length).toBeGreaterThan(0);
    // The occupancy headline replaces the old stacked bars (and their unlabelled axis):
    // a percentage over one filled track per property.
    expect(container.querySelector('.occ-figure').textContent).toMatch(/^\d+%$/);
    expect(container.querySelectorAll('.occ-row').length).toBeGreaterThan(0);
    // The Revenue/Expenses/NOI triad, in a panel that now spans the whole band.
    expect(screen.getByText('Revenue')).toBeTruthy();
    expect(screen.getByText('NOI')).toBeTruthy();
    expect(container.querySelector('.chart-panel.wide')).toBeTruthy();
    // …and it says which "expenses" it means. A bar labelled only "Expenses" can't tell a
    // landlord whether it's the actuals he entered or the CAM & tax estimates he bills —
    // two genuinely different figures, the gap between them being the year-end true-up.
    expect(screen.getByText(/actual property taxes, CAM and roof/i)).toBeTruthy();
    expect(screen.getByText(/not the CAM & tax estimates billed to tenants/i)).toBeTruthy();
  });

  it('no longer draws the three metric cards — the charts say all three better', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Where the rent comes from')).toBeTruthy());
    expect(container.querySelector('.metric-group')).toBeNull();
    expect(screen.queryByText('Expiring ≤ 6 months')).toBeNull();
    expect(screen.queryByText('Occupancy')).toBeNull();
  });

  // George, 2026-07-30: "you can remove the lease expirations table because it will be a
  // notification no need to double down." The termination alert covers the same leases on
  // the same lead and is clickable to the lease — so the table was saying it twice.
  it('no longer draws the lease expirations table — the Lease endings column says it', async () => {
    renderDash();
    await waitFor(() => expect(screen.getByText('Alerts & notifications')).toBeTruthy());
    expect(screen.queryByText(/Lease expirations/)).toBeNull();
    expect(screen.getByText('Lease endings')).toBeTruthy();
  });

  it('disappears entirely when the landlord hides the widget', async () => {
    await setHiddenWidgets(['portfolio_charts']);
    renderDash();
    await waitFor(() => expect(screen.getByText('Overview')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Where the rent comes from')).toBeNull());
  });
});

describe('Overview — alert urgency', () => {
  it('gives a date-driven alert a countdown chip, an urgency hairline and a who/where tooltip', async () => {
    const { container } = renderDash();
    // The demo seed carries lease-end / renewal-notice dates, so at least one date-driven
    // alert always renders.
    await waitFor(() => expect(screen.getByText('Alerts & notifications')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.alert-days')).toBeTruthy());

    // "118d" or "63d over" — the figure is a whole number of days, never a negative sign;
    // "over" carries the direction, so "-14d" can't happen.
    expect(container.querySelector('.alert-days').textContent).toMatch(/^\d+d( over)?$/);

    const bar = container.querySelector('.alert-progress > span');
    expect(bar).toBeTruthy();
    const pct = Number(String(bar.style.width).replace('%', ''));
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);

    // The who/where an alert can't carry itself (it holds ids, not names) moved into the
    // hover panel when the rows were compacted — but it must still be there.
    const row = container.querySelector('.alert-days').closest('.nrow');
    expect(row.querySelector('.nrow-pop-where').textContent).toMatch(/Maple Plaza|Oak Center/);
    // …along with the full title and the bucket + date the one-line row dropped.
    expect(row.querySelector('.nrow-pop-title').textContent.length).toBeGreaterThan(0);
    expect(row.querySelector('.nrow-pop-foot')).toBeTruthy();
  });

  it('shows NO countdown on a ledger reminder — its days value is a sort weight', async () => {
    // Drop Bright Coffee's untagged lump so prop-1's later months lose their cover and a
    // statement reminder appears (the statementReminderData precedent). That alert sorts
    // by month count, so rendering "-2 days over" beside a bar would be a fabrication.
    const before = await listPayments('inv-1');
    await supabase.from('payments').delete().eq('invoice_id', 'inv-1');
    try {
      const { container } = renderDash();
      await waitFor(() => expect(screen.getByText('Alerts & notifications')).toBeTruthy());
      const reminder = await waitFor(() => {
        // A compact row shows only its subject; the full title lives in the hover panel.
        const el = [...container.querySelectorAll('.callout')]
          .find((n) => /Import your .*statement/i.test(n.textContent));
        expect(el).toBeTruthy();
        return el;
      });
      expect(reminder.querySelector('.alert-days')).toBeNull();
      // …while a dated alert on the same screen still has one.
      expect(container.querySelector('.alert-days')).toBeTruthy();
      // The BAR, unlike the countdown, is now present on every row — a standing problem
      // with no deadline is pinned full, because it ranks above anything merely upcoming
      // and a gap mid-column would break the descent the sort guarantees.
      const fill = reminder.querySelector('.alert-progress > span');
      expect(fill).toBeTruthy();
      expect(fill.style.width).toBe('100%');
    } finally {
      for (const p of before) await supabase.from('payments').insert(p);
    }
  });
});
