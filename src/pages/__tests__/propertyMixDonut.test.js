// Mounts the REAL PropertiesPage against the demo mock — the page George pointed at
// ("i want it on the same page as the property card for example: pershing plaza and
// Joliet"). The shaper is pinned in portfolioCharts.test.js and the hover in
// chartTooltips.test.js; what only a render can prove is that the donut reaches the card
// at all, and that the card's existing figures still read correctly beside it.
//
// Unusually for a chart in this codebase, the slices ARE assertable here: the donut is a
// fixed-size PieChart rather than a ResponsiveContainer (which measures 0×0 in jsdom and
// draws nothing), so the sectors really render.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PropertiesPage from '../PropertiesPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { supabase } from '../../lib/supabaseClient';

function renderProps(corpId = 'corp-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/leases/${corpId}`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes><Route path="/leases/:corpId" element={<PropertiesPage />} /></Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const cardFor = (container, name) =>
  [...container.querySelectorAll('.prop-card')].find((n) => n.textContent.includes(name));

beforeEach(() => cleanup());

describe('Property cards — tenant mix donut', () => {
  it('draws a donut on each property card, headlined with the leased share', async () => {
    const { container } = renderProps();
    const card = await waitFor(() => {
      const el = cardFor(container, 'Maple Plaza');
      expect(el).toBeTruthy();
      return el;
    });
    const donut = card.querySelector('.prop-mix');
    expect(donut).toBeTruthy();
    // The centre states the headline even before a hover — a donut whose only content is
    // in a tooltip says nothing at a glance.
    expect(donut.querySelector('.prop-mix-figure').textContent).toMatch(/^\d+%$/);
    expect(donut.querySelector('.prop-mix-cap').textContent).toBe('leased');
    // One slice per sized tenant, biggest first — the demo's Maple Plaza is City Dental
    // (3,000 SF) then Bright Coffee (2,000 SF), fully leased so no vacant slice.
    const names = [...donut.querySelectorAll('path.recharts-sector')].map((p) => p.getAttribute('name'));
    expect(names).toEqual(['City Dental', 'Bright Coffee Co.']);
  });

  it('names every slice with its share of the building, without needing a hover', async () => {
    // George, 2026-07-30: "for each section, put the title of the tenant and the percent
    // square footage." Naming them on the chart itself doesn't survive nine tenants — the
    // labels collide — so the legend carries it, permanently.
    const { container } = renderProps();
    const legend = await waitFor(() => {
      const el = cardFor(container, 'Maple Plaza').querySelector('.prop-mix-legend');
      expect(el).toBeTruthy();
      return el;
    });
    const rows = [...legend.querySelectorAll('li')].map((li) => [
      li.querySelector('.prop-mix-name').textContent,
      li.querySelector('.prop-mix-pct')?.textContent,
    ]);
    // Biggest first, same order as the slices, each with its percentage.
    expect(rows).toEqual([['City Dental', '60.0%'], ['Bright Coffee Co.', '40.0%']]);
    // Every legend entry carries the swatch that ties it to its slice.
    expect(legend.querySelectorAll('.prop-mix-swatch')).toHaveLength(2);
    // Maple Plaza is fully leased, so there is no vacant entry to invent.
    expect(legend.querySelector('.prop-mix-vacant')).toBeNull();
  });

  it('names the vacant space too — it is what the percentages are “of”', async () => {
    // Shrink one tenant so the building is no longer fully leased.
    const { data: before } = await supabase.from('leases').select('square_footage').eq('id', 'lease-1').single();
    await supabase.from('leases').update({ square_footage: 1500 }).eq('id', 'lease-1');
    try {
      const { container } = renderProps();
      const vacant = await waitFor(() => {
        const el = cardFor(container, 'Maple Plaza')?.querySelector('.prop-mix-vacant');
        expect(el).toBeTruthy();
        return el;
      });
      expect(vacant.querySelector('.prop-mix-name').textContent).toBe('Vacant');
      expect(vacant.querySelector('.prop-mix-pct').textContent).toBe('10.0%'); // 500 of 5,000
    } finally {
      await supabase.from('leases').update({ square_footage: before.square_footage }).eq('id', 'lease-1');
    }
  });

  it('names every tenant — a crowded building gets no “+N more” placeholder', async () => {
    // George, 2026-07-30: "says +1 more and vacant - go with the vacant drop the +1."
    // His Pershing Plaza has nine tenants, which is exactly where the old cap of eight
    // bit — and the one entry it hid was a real tenant, which is the whole point of the
    // legend. Seven extra leases here put Maple Plaza in the same shape.
    const extra = Array.from({ length: 7 }, (_, i) => ({
      id: `lease-mix-${i}`, property_id: 'prop-1', tenant_name: `Filler Tenant ${i + 1}`,
      square_footage: 100, base_rent: 3000,
    }));
    await supabase.from('leases').insert(extra);
    try {
      const { container } = renderProps();
      const legend = await waitFor(() => {
        const el = cardFor(container, 'Maple Plaza')?.querySelector('.prop-mix-legend');
        expect(el.querySelectorAll('li').length).toBeGreaterThan(8);
        return el;
      });
      const names = [...legend.querySelectorAll('.prop-mix-name')].map((n) => n.textContent);
      expect(names).toHaveLength(9);                       // 2 seeded + 7 filler
      expect(names.some((n) => /more$/.test(n))).toBe(false);
      expect(names).toContain('Filler Tenant 7');          // the one the cap used to eat
    } finally {
      await supabase.from('leases').delete().in('id', extra.map((l) => l.id));
    }
  });

  it('keeps the hover panel up while the cursor crosses the donut’s hole', async () => {
    // George, 2026-07-30: "when i go into the circle of the pie chart like where it says
    // 94% it resets the pop up which is kind of an eye sore." recharts' own <Tooltip>
    // clears the moment the cursor is off a sector, and the hole is off every sector — so
    // the panel is state we own, cleared only when the pointer leaves the whole chart.
    const { container } = renderProps();
    const chart = await waitFor(() => {
      const el = cardFor(container, 'Maple Plaza')?.querySelector('.prop-mix-chart');
      expect(el.querySelector('path.recharts-sector')).toBeTruthy();
      return el;
    });
    expect(chart.querySelector('.prop-mix-tip')).toBeNull();   // nothing before a hover

    const [first] = chart.querySelectorAll('path.recharts-sector');
    fireEvent.mouseOver(first);
    await waitFor(() => expect(chart.querySelector('.prop-mix-tip')).toBeTruthy());
    expect(chart.querySelector('.prop-mix-tip').textContent).toContain('City Dental');

    // Off the slice, into the middle — the regression. The panel must NOT flash out.
    fireEvent.mouseOut(first);
    fireEvent.mouseOver(chart.querySelector('.prop-mix-center'));
    expect(chart.querySelector('.prop-mix-tip')).toBeTruthy();
    expect(chart.querySelector('.prop-mix-tip').textContent).toContain('City Dental');

    // Leaving the chart entirely does clear it.
    fireEvent.mouseLeave(chart);
    await waitFor(() => expect(chart.querySelector('.prop-mix-tip')).toBeNull());
  });

  it('leaves the card’s existing figures exactly where they were', async () => {
    const { container } = renderProps();
    const card = await waitFor(() => {
      const el = cardFor(container, 'Maple Plaza');
      expect(el.querySelector('.prop-card-stats')).toBeTruthy();
      return el;
    });
    const labels = [...card.querySelectorAll('.prop-card-stats .muted')].map((n) => n.textContent);
    expect(labels).toEqual(['Tenants', 'Sq ft', 'Leased', 'Revenue']);
    // The donut's centre and the card's own "Leased" stat are two derivations of the same
    // thing, so they have to agree — the whole point of reading both from the same rows.
    const stat = card.querySelectorAll('.prop-card-stats b')[2].textContent;
    expect(card.querySelector('.prop-mix-figure').textContent).toBe(stat);
  });

  it('draws no donut on a property with no leases and no building size', async () => {
    // Nothing to divide — a donut of nothing is worse than no donut.
    const { data } = await supabase.from('properties').insert({
      id: 'prop-empty-test', corporation_id: 'corp-1', name: 'Empty Lot', address: '', building_sf: null,
    }).select().single();
    try {
      const { container } = renderProps();
      const card = await waitFor(() => {
        const el = cardFor(container, 'Empty Lot');
        expect(el).toBeTruthy();
        return el;
      });
      expect(card.querySelector('.prop-mix')).toBeNull();
      // …and the card itself still renders fine.
      expect(screen.getByText('Empty Lot')).toBeTruthy();
    } finally {
      await supabase.from('properties').delete().eq('id', data.id);
    }
  });
});
