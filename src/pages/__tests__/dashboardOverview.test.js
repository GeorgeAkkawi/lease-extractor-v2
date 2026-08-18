// Render smoke test for the two Overview additions: the "Portfolio at a glance" chart
// band and the urgency visuals inside the existing alerts panel. Mounts the REAL
// DashboardPage against the demo mock, so a crash, a missing field or a broken widget
// gate surfaces here rather than in the browser.
//
// One jsdom caveat drives every assertion below: recharts' ResponsiveContainer measures
// its parent, and in jsdom every element is 0×0 — so no SVG is ever drawn. Assert the
// panel titles and legends (real DOM, rendered regardless), never chart geometry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
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
  it('renders the three panels drawn from the seeded portfolio', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Where the rent comes from')).toBeTruthy());
    expect(screen.getByText('Space leased')).toBeTruthy();
    expect(screen.getByText('Rent coming up for renewal')).toBeTruthy();
    // The panel has to say what a bar is, not just what it's called: City Dental's term
    // ended in May and it's still in place, so the demo always carries a "Now" bucket —
    // and the foot has to explain it rather than leave a bar labelled "Now" to guesswork.
    expect(screen.getByText(/already past its end date/)).toBeTruthy();
    // The donut's centre caption — and the ONLY place the rent roll is stated.
    expect(screen.getAllByText('Annual rent roll').length).toBe(1);
    expect(screen.getAllByText(/Maple Plaza/).length).toBeGreaterThan(0);
    // The occupancy headline replaces the old stacked bars (and their unlabelled axis):
    // a percentage over one filled track per property.
    expect(container.querySelector('.occ-figure').textContent).toMatch(/^\d+%$/);
    expect(container.querySelectorAll('.occ-row').length).toBeGreaterThan(0);
  });

  // George, 2026-08-18: *"we can take out the bar graph projected vs live."* It drew each
  // property's year twice over in four bars; the band above says the same thing for the
  // portfolio, in figures, and reconciles with the donut.
  it('no longer draws the per-property projected-vs-live bars', async () => {
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Where the rent comes from')).toBeTruthy());
    expect(container.querySelector('.chart-panel.wide')).toBeNull();
    expect(screen.queryByText('Projected vs live, by property')).toBeNull();
    expect(screen.queryByText('What each property keeps')).toBeNull();
  });

  // ⚠ THE ONE THAT MATTERS, and the complaint it closes. The band used to put an all-in,
  // prorated projection above a donut showing base rent at the annual rate — two headline
  // figures on one screen, $122,577 apart on George's portfolio, with nothing saying why.
  // Revenue now comes from the very figure the donut sums.
  it('quotes the same rent as the donut beneath it, to the cent', async () => {
    const { container } = renderDash();
    const band = await waitFor(() => {
      const el = container.querySelector('.basis-band');
      expect(el).toBeTruthy();
      return el;
    });
    const donut = container.querySelector('.donut-figure').textContent.trim();
    const revenueProjected = band.querySelector('.basis-col .basis-amt').textContent.trim();
    expect(revenueProjected).toBe(donut);
  });

  // George: *"there should be a total collumn instead of the whats left."*
  it('heads the page with Revenue, Expenses and Total, each read twice', async () => {
    const { container } = renderDash();
    const band = await waitFor(() => {
      const el = container.querySelector('.basis-band');
      expect(el).toBeTruthy();
      return el;
    });
    expect([...band.querySelectorAll('.basis-col-label')].map((n) => n.firstChild.textContent))
      .toEqual(['Revenue', 'Expenses', 'Total']);
    // Each column says WHICH figure it is — "Expenses" alone can't tell the CAM & tax you
    // bill from the CAM & tax you pay.
    expect([...band.querySelectorAll('.basis-col-sub')].map((n) => n.textContent))
      .toEqual(['base rent', 'CAM & tax billed', 'what tenants are charged']);
    expect(band.querySelectorAll('.basis-fig').length).toBe(6);
    expect(within(band).getAllByText('projected').length).toBe(3);
    expect(within(band).getAllByText('live').length).toBe(3);
    // "What's left" and its NOI reconciliation are gone — the columns add now.
    expect(within(band).queryByText(/What’s left/)).toBeNull();
    expect(band.textContent).not.toMatch(/NOI/);
    // It is the headline, so it comes BEFORE the panels it introduces.
    const charts = container.querySelector('.chart-band');
    expect(band.compareDocumentPosition(charts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  // One switch, not two: the band is the headline of the same idea the panels below
  // elaborate, and a second key would let a landlord hide half of it.
  it('disappears entirely when the landlord hides the widget, band included', async () => {
    await setHiddenWidgets(['portfolio_charts']);
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Overview')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Where the rent comes from')).toBeNull());
    expect(container.querySelector('.basis-band')).toBeNull();
  });
});

// ── Why the two readings differ ───────────────────────────────────────────────────────────
//
// George, 2026-08-18: *"at the end of the year it should give a summary of any differences in
// the numbers and where they came from for the projected vs live stats"*. The arithmetic is
// pinned in `yearBridge.test.js`; this pins that a landlord can actually reach it — which is the
// half a pure-function test cannot see, and the half CLAUDE.md's §7 is about.
describe('Overview — where the difference is', () => {
  const bridgeIn = async (container) => waitFor(() => {
    const el = container.querySelector('.basis-bridge');
    expect(el).toBeTruthy();
    return el;
  });

  // ⚠ FOLDED, IT STILL STATES THE ANSWER. That is Panel's own rule and the whole reason this is
  // a fold rather than a link: a landlord who never opens it must still learn the year is short
  // and roughly why. A summary that said "3 causes" would be the count CLAUDE.md §5 refuses.
  it('starts folded and still says what the year did, in dollars', async () => {
    const { container } = renderDash();
    const bridge = await bridgeIn(container);
    const toggle = bridge.querySelector('button.panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toMatch(/where the difference is/);
    // Two figures and a gap, all real dollars — never a bare count.
    expect(toggle.querySelector('.panel-note').textContent).toMatch(/^\$[\d,]+\.\d\d billed, \$[\d,]+\.\d\d in/);
    // Nothing of the working is on screen until it is asked for.
    expect(container.querySelector('.basis-bridge-terms')).toBeNull();
  });

  it('opens onto the band’s own three measures, each with the causes behind its gap', async () => {
    const { container } = renderDash();
    const bridge = await bridgeIn(container);
    fireEvent.click(bridge.querySelector('button.panel-toggle'));

    const names = [...bridge.querySelectorAll('.basis-bridge-measure-name')].map((n) => n.firstChild.textContent);
    expect(names).toEqual(['Revenue', 'Expenses', 'Total']);
    // The same sub-labels the columns above carry — one vocabulary, not two.
    expect([...bridge.querySelectorAll('.basis-bridge-measure .basis-col-sub')].map((n) => n.textContent))
      .toEqual(['base rent', 'CAM & tax billed', 'what tenants are charged']);

    // Every cause is a signed dollar figure with a sentence, and the demo seed has arrears.
    const terms = [...bridge.querySelectorAll('.basis-bridge-terms li')];
    expect(terms.length).toBeGreaterThan(0);
    for (const li of terms) {
      expect(li.querySelector('.basis-term-amt').textContent).toMatch(/^[+−]\$[\d,]+\.\d\d$/);
      expect(li.querySelector('.basis-term-label').textContent.trim().length).toBeGreaterThan(10);
    }
    expect(bridge.textContent).toMatch(/rent billed and not yet in/);
    // ⚠ AND NOTHING IT CANNOT ACCOUNT FOR. The catch-all is real, so its absence on a clean
    // seed is the assertion — a bridge that always prints one has stopped meaning anything.
    expect(bridge.querySelector('.is-unexplained')).toBeNull();
  });

  // ⚠ THE TWO SENTENCES MOVED, THEY WERE NOT COPIED. Other income and unapplied cash were
  // hand-written in the band's foot AND are figures the bridge derives per property; leaving
  // both would put one figure on screen twice from two sources, which is the §3 drift this
  // codebase keeps paying for.
  it('says other income and unapplied cash once, in the bridge and not in the band’s foot', async () => {
    const { container } = renderDash();
    const band = await waitFor(() => {
      const el = container.querySelector('.basis-band');
      expect(el).toBeTruthy();
      return el;
    });
    const foot = band.querySelector('.basis-foot');
    const outsideBridge = [...foot.children].filter((n) => !n.classList.contains('basis-bridge'));
    expect(outsideBridge.length).toBe(1);
    expect(outsideBridge[0].textContent).toMatch(/Projected.*Live/s);
    expect(outsideBridge[0].textContent).not.toMatch(/other income|arrived beyond/i);
  });

  // §7 in one assertion: it rides the band's switch, so hiding the widget cannot leave a
  // reconciliation of figures that are no longer on screen.
  it('goes with the widget the band goes with', async () => {
    await setHiddenWidgets(['portfolio_charts']);
    const { container } = renderDash();
    await waitFor(() => expect(screen.getByText('Overview')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.basis-band')).toBeNull());
    expect(container.querySelector('.basis-bridge')).toBeNull();
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
