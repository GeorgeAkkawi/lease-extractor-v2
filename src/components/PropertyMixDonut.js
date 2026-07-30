import { useState } from 'react';
import { PieChart, Pie, Cell } from 'recharts';
import { tenantMix, DONUT_PALETTE, CHART_SERIES, shortName } from '../lib/portfolioCharts';
import { money, sf, pct, approx } from '../lib/format';

const sliceFill = (d, i) =>
  (d.kind === 'vacant' ? CHART_SERIES.vacant : DONUT_PALETTE[i % DONUT_PALETTE.length]);

// Who occupies this building — the donut on each property card.
//
// George asked for "percentage of building and psf base rent when hovering", and until
// now neither figure appeared anywhere on a tenant row: the only % of building on the
// whole Leases page was the vacancy line at the bottom. The card already holds every
// input (the batched ['leases', propId] cache plus property.building_sf), so this costs
// no network call and can't disagree with the tenant count / SF / Leased figures beside
// it — same rows, same denominator.
//
// The LEGEND is what makes it readable rather than a decoration (George, 2026-07-30:
// "for each section, put the title of the tenant and the percent square footage"). Naming
// every slice on the chart itself doesn't survive nine tenants — the labels collide, and
// the small ones have nowhere to sit — so the names go beside it, permanently, and the
// hover keeps the deeper read ($/SF and annual rent).
export default function PropertyMixDonut({ property, leases, size = 150 }) {
  const mix = tenantMix(property, leases);
  // Which slice the hover panel is describing. Held HERE rather than by recharts' own
  // <Tooltip> because recharts clears it the moment the cursor is off a sector — and the
  // donut's hole is off every sector, so crossing the middle made the panel flash out and
  // back (George, 2026-07-30: "when i go into the circle … it resets the pop up which is
  // kind of an eye sore"). Owning the state lets it survive until the pointer leaves the
  // whole chart, which is the sticky behaviour he asked for.
  const [activeId, setActiveId] = useState(null);

  // A donut of nothing is worse than no donut: a property with no sized leases and no
  // building size has nothing to divide.
  if (mix.length === 0) return null;

  const building = Number(property?.building_sf) || mix.reduce((s, r) => s + r.sf, 0);
  const tenants = mix.filter((r) => r.kind === 'tenant');
  const vacant = mix.find((r) => r.kind === 'vacant');
  const leasedPct = tenants.reduce((s, r) => s + r.pct, 0);
  const active = mix.find((d) => d.id === activeId) || null;

  return (
    <div className="prop-mix" onClick={(e) => e.stopPropagation()} role="presentation">
      {/* Fixed size rather than a ResponsiveContainer: the donut is always `size` px, so
          there is nothing to measure — and a container that measures 0×0 (which is what
          happens under the phone breakpoint, where the donut is hidden) makes recharts
          warn on every render. A fixed chart also actually DRAWS in jsdom.

          The mouseleave is on this WRAPPER, not on the sectors: everything inside it —
          the hole, the centre figure, the square's corners — keeps the panel up. */}
      <div
        className="prop-mix-chart"
        style={{ width: size, height: size }}
        onMouseLeave={() => setActiveId(null)}
      >
        <PieChart width={size} height={size}>
          <Pie
            data={mix} dataKey="sf" nameKey="name"
            cx="50%" cy="50%"
            innerRadius="56%" outerRadius="94%" paddingAngle={mix.length > 1 ? 1.5 : 0}
            stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false}
            onMouseEnter={(_d, i) => setActiveId(mix[i]?.id ?? null)}
          >
            {mix.map((d, i) => <Cell key={d.id} fill={sliceFill(d, i)} />)}
          </Pie>
        </PieChart>
        <div className="prop-mix-center" aria-hidden="true">
          <div className="prop-mix-figure">{Math.round(leasedPct * 100)}%</div>
          <div className="prop-mix-cap">leased</div>
        </div>
        {/* PINNED beside the chart rather than following the cursor. On a chart this small
            a cursor-tracked panel lands on top of the very slice being pointed at —
            George, 2026-07-30: "if I hover over the chart … I don't see the chart." A
            fixed spot also stops it jittering across a 150px target. It opens over the
            legend, which has already done its job by the time you're hovering. */}
        {active && (
          <div className="prop-mix-tip" style={{ '--tip-x': `${size + 12}px` }}>
            <TenantMixTip active payload={[{ payload: active }]} building={building} />
          </div>
        )}
      </div>

      {/* Every tenant is named — no "+N more" row. It bought a shorter legend at the cost
          of the one thing the legend is for (George, 2026-07-30: "says +1 more and vacant
          - go with the vacant drop the +1"), and a two-column legend absorbs a nine-tenant
          building without the card growing much at all. */}
      <ul className="prop-mix-legend">
        {tenants.map((d, i) => (
          <li key={d.id} title={`${d.name} — ${sf(d.sf)} · ${pct(d.pct)} of building`}>
            <span className="prop-mix-swatch" style={{ background: sliceFill(d, i) }} aria-hidden="true" />
            <span className="prop-mix-name">{shortName(d.name, 22)}</span>
            <span className="prop-mix-pct">{pct(d.pct)}</span>
          </li>
        ))}
        {vacant && (
          <li className="prop-mix-vacant" title={`Vacant space — ${sf(vacant.sf)} · ${pct(vacant.pct)} of building`}>
            <span className="prop-mix-swatch" style={{ background: sliceFill(vacant, 0) }} aria-hidden="true" />
            <span className="prop-mix-name">Vacant</span>
            <span className="prop-mix-pct">{pct(vacant.pct)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

// The hover — George's actual ask. Exported only so a test can render it: recharts'
// ResponsiveContainer measures 0×0 in jsdom, so nothing inside a chart is ever drawn
// there and a crash in here would reach the browser unseen (the chartTooltips precedent).
export function TenantMixTip({ active, payload, building }) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;

  const share = `${sf(d.sf)} · ${pct(d.pct)} of building`;

  if (d.kind === 'vacant') {
    return (
      <div className="chart-tip">
        <div className="chart-tip-head">Vacant space</div>
        <div className="chart-tip-total muted">{share}</div>
        <p className="chart-tip-note">Unleased — nothing to collect.</p>
      </div>
    );
  }

  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{shortName(d.name, 28)}</div>
      <div className="chart-tip-total muted">{share}</div>
      <ul className="chart-tip-list">
        <li>
          <span className="chart-tip-name">Base rent</span>
          <span className="chart-tip-val">{d.rent > 0 ? `${money(d.rent)}/yr` : '—'}</span>
        </li>
        {d.psf != null && d.psf > 0 && (
          <li className="chart-tip-part">
            <span className="chart-tip-name" />
            {/* The rate is derived from the annual figure directly above it, so it says
                so when it can't be multiplied back (format.js approx, 2026-07-24). */}
            <span className="chart-tip-val">{approx(d.rent, d.sf)}${d.psf.toFixed(2)} /SF/yr</span>
          </li>
        )}
      </ul>
      {building > 0 && (
        <p className="chart-tip-note">Of {sf(building)} total.</p>
      )}
    </div>
  );
}
