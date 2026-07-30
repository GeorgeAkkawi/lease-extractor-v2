import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { tenantMix, DONUT_PALETTE, CHART_SERIES, shortName } from '../lib/portfolioCharts';
import { money, sf, pct, approx } from '../lib/format';

// Who occupies this building — the donut on each property card.
//
// George asked for "percentage of building and psf base rent when hovering", and until
// now neither figure appeared anywhere on a tenant row: the only % of building on the
// whole Leases page was the vacancy line at the bottom. The card already holds every
// input (the batched ['leases', propId] cache plus property.building_sf), so this costs
// no network call and can't disagree with the tenant count / SF / Leased figures beside
// it — same rows, same denominator.
export default function PropertyMixDonut({ property, leases, size = 118 }) {
  const mix = tenantMix(property, leases);
  // A donut of nothing is worse than no donut: a property with no sized leases and no
  // building size has nothing to divide.
  if (mix.length === 0) return null;

  const building = Number(property?.building_sf) || mix.reduce((s, r) => s + r.sf, 0);
  const leasedPct = mix
    .filter((r) => r.kind === 'tenant')
    .reduce((s, r) => s + r.pct, 0);

  return (
    <div className="prop-mix" onClick={(e) => e.stopPropagation()} role="presentation">
      {/* Fixed size rather than a ResponsiveContainer: the donut is always `size` px, so
          there is nothing to measure — and a container that measures 0×0 (which is what
          happens under the phone breakpoint, where the donut is hidden) makes recharts
          warn on every render. A fixed chart also actually DRAWS in jsdom. */}
      <div className="prop-mix-chart" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie
            data={mix} dataKey="sf" nameKey="name"
            cx="50%" cy="50%"
            innerRadius="58%" outerRadius="94%" paddingAngle={mix.length > 1 ? 1.5 : 0}
            stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false}
          >
            {mix.map((d, i) => (
              <Cell
                key={d.id}
                fill={d.kind === 'vacant' ? CHART_SERIES.vacant : DONUT_PALETTE[i % DONUT_PALETTE.length]}
              />
            ))}
          </Pie>
          <Tooltip content={<TenantMixTip building={building} />} />
        </PieChart>
        <div className="prop-mix-center" aria-hidden="true">
          <div className="prop-mix-figure">{Math.round(leasedPct * 100)}%</div>
          <div className="prop-mix-cap">leased</div>
        </div>
      </div>
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
