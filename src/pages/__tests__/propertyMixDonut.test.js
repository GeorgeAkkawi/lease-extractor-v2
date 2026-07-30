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
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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
