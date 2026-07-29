import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from 'recharts';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, revenueExpensesNoi, rentRollover,
  CHART_SERIES, DONUT_PALETTE, ROLLOVER_RAMP, kfmt, shortName,
} from '../lib/portfolioCharts';
import { money, money0, sf } from '../lib/format';
import { localDateIso } from '../lib/api';

// "Portfolio at a glance" — the Overview's chart band, and now the top of the page.
//
// Everything here is drawn from the two queries the dashboard already runs (the search
// index + v_property_totals for the selected fiscal year), so it costs nothing extra to
// render and always agrees with the property pages it sums.
//
// Each panel earns its place by answering a question a figure alone can't: WHERE the rent
// comes from (concentration by tenant), HOW MUCH space sits empty, WHEN the rent comes up
// for renewal (concentration in time), and WHICH property actually keeps what it earns.
// A panel with nothing to say hides itself rather than drawing an empty frame.
export default function PortfolioCharts({ properties = [], totalsByProp = {}, leases = [], year }) {
  const revenue = revenueByProperty(properties, totalsByProp);
  const space = occupancyByProperty(properties, totalsByProp);
  const performance = revenueExpensesNoi(properties, totalsByProp);
  const rollover = rentRollover(leases, localDateIso());

  if (!revenue.length && !space.length && !performance.length && !rollover.length) return null;

  const revenueTotal = revenue.reduce((s, d) => s + d.value, 0);
  const topShare = revenueTotal > 0 && revenue.length ? Math.round((revenue[0].value / revenueTotal) * 100) : null;

  const portfolio = portfolioOccupancy(space);

  // The share of the whole roll that comes up inside the window, so the bars carry a
  // headline: "46% of the roll comes up by 2030". Denominator is every active lease's
  // rent — including leases with no term end, which is honest: they are part of the roll
  // and simply aren't rolling off.
  const rollTotal = (leases || []).filter((l) => l.is_active !== false)
    .reduce((s, l) => s + (Number(l.base_rent) || 0), 0);
  const rolloverTotal = rollover.reduce((s, d) => s + d.value, 0);
  const rolloverPct = rollTotal > 0 ? Math.round((rolloverTotal / rollTotal) * 100) : null;
  const lastBucket = rollover.length ? rollover[rollover.length - 1].label : null;
  const rolloverCount = rollover.reduce((s, d) => s + d.count, 0);

  // The panel has to say what a bar IS before it can say anything else — the title alone
  // left it guessable. Assembled rather than fixed so each clause is only stated when
  // it's true: the share needs a year to run to, the "Now" note needs a Now bucket.
  const hasNow = rollover.some((d) => d.kind === 'now');
  const rolloverFoot = [
    rolloverPct != null && lastBucket && lastBucket !== 'Now'
      ? `${money0(rolloverTotal)} — ${rolloverPct}% of your rent — comes up by ${lastBucket}.`
      : `${rolloverCount} lease${rolloverCount === 1 ? '' : 's'}.`,
    hasNow ? '“Now” is rent already past its end date — a tenant holding over.' : null,
    'At today’s rent, not a forecast.',
  ].filter(Boolean).join(' ');

  const showBarLabels = performance.length <= 6;

  return (
    <div className="chart-band">
      {revenue.length > 0 && (
        <ChartPanel
          title="Where the rent comes from"
          caption={topShare != null && revenue.length > 1
            ? `${shortName(revenue[0].name, 24)} is ${topShare}% of the roll`
            : `FY ${year}`}
        >
          <div className="donut-wrap">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={revenue} dataKey="value" nameKey="name"
                  innerRadius="62%" outerRadius="92%" paddingAngle={revenue.length > 1 ? 1.5 : 0}
                  stroke="var(--panel)" strokeWidth={2} isAnimationActive={false}
                >
                  {revenue.map((d, i) => <Cell key={d.id} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [money(v), n]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-center" aria-hidden="true">
              <div className="donut-figure">{money0(revenueTotal)}</div>
              <div className="donut-cap">Annual rent roll</div>
            </div>
          </div>
          <div className="chart-legend wrap">
            {revenue.slice(0, 6).map((d, i) => (
              <span key={d.id} title={`${d.name} · ${money(d.value)}`}>
                <span className="sw" style={{ background: DONUT_PALETTE[i % DONUT_PALETTE.length] }} />
                {shortName(d.name)}
              </span>
            ))}
            {revenue.length > 6 && <span className="muted">+{revenue.length - 6} more</span>}
          </div>
        </ChartPanel>
      )}

      {/* Space leased — a headline percentage over one filled track per property. No axes:
          the question is a ratio inside each property, which a track answers directly and a
          stacked bar chart didn't. Most vacant first, because the empty space is the point. */}
      {properties.length > 0 && (
        <ChartPanel title="Space leased" caption="Of each property’s building size">
          {portfolio ? (
            <div className="occ-body">
              <div className="occ-head">
                <div className="occ-figure">{portfolio.pct}%</div>
                <div className="occ-cap">
                  {portfolio.vacant > 0
                    ? `Leased · ${sf(portfolio.vacant)} empty of ${sf(portfolio.building)}`
                    : `Fully leased · ${sf(portfolio.building)}`}
                </div>
              </div>
              <div className="occ-rows">
                {space.map((r) => (
                  <div
                    key={r.id}
                    className="occ-row"
                    title={`${r.name} — ${sf(r.leased)} leased of ${sf(r.building)}${r.vacant > 0 ? ` · ${sf(r.vacant)} empty` : ''}`}
                  >
                    <div className="occ-name">{shortName(r.name, 20)}</div>
                    <div className="occ-track"><span style={{ width: `${Math.max(2, r.pct)}%` }} /></div>
                    <div className="occ-pct">{r.pct}%</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="empty-line muted" style={{ margin: '4px 0 10px' }}>
              Add each property’s building size to see how much space is empty.
            </p>
          )}
        </ChartPanel>
      )}

      {/* Rent coming up for renewal — the exposure the other panels can't show, because
          they're all about today. "Now" is rent already sitting on holdover. */}
      {rollover.length > 0 && (
        <ChartPanel
          title="Rent coming up for renewal"
          caption="Annual rent on the leases ending each year"
        >
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rollover} margin={{ top: 16, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,19,.1)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
              <YAxis tickFormatter={kfmt} tick={{ fontSize: 10 }} />
              <Tooltip
                formatter={(v, n, p) => [money(v), `${p?.payload?.count || 0} lease${p?.payload?.count === 1 ? '' : 's'}`]}
                labelFormatter={(l) => (l === 'Now' ? 'Already in holdover' : `Expiring ${l}`)}
              />
              <Bar dataKey="value" isAnimationActive={false} maxBarSize={58}>
                {rollover.map((d, i) => <Cell key={d.key} fill={ROLLOVER_RAMP[Math.min(i, ROLLOVER_RAMP.length - 1)]} />)}
                <LabelList dataKey="value" position="top" formatter={kfmt} className="bar-label" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="chart-foot">{rolloverFoot}</p>
        </ChartPanel>
      )}

      {/* Full width: three grouped bars per property, each carrying its own figure. At a
          third of the band the labels would collide — and this is the comparison the other
          three panels lead up to, so it earns the room. */}
      {performance.length > 0 && (
        <ChartPanel title="What each property keeps" caption={`Revenue · expenses · NOI · FY ${year}`} wide>
          <div className="chart-legend">
            <span><span className="sw" style={{ background: CHART_SERIES.revenue }} /> Revenue</span>
            <span><span className="sw" style={{ background: CHART_SERIES.expenses }} /> Expenses</span>
            <span><span className="sw" style={{ background: CHART_SERIES.noi }} /> NOI</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={performance} margin={{ top: 16, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,19,.1)" vertical={false} />
              <XAxis dataKey="name" tickFormatter={(v) => shortName(v, 16)} tick={{ fontSize: 10 }} interval={0} />
              <YAxis tickFormatter={kfmt} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => money(v)} />
              {/* Above ~6 properties the figures start colliding; the tooltip still carries
                  them, and a row of overlapping numbers is worse than none. */}
              <Bar dataKey="Revenue" fill={CHART_SERIES.revenue} isAnimationActive={false} maxBarSize={54}>
                {showBarLabels && <LabelList dataKey="Revenue" position="top" formatter={kfmt} className="bar-label" />}
              </Bar>
              <Bar dataKey="Expenses" fill={CHART_SERIES.expenses} isAnimationActive={false} maxBarSize={54}>
                {showBarLabels && <LabelList dataKey="Expenses" position="top" formatter={kfmt} className="bar-label" />}
              </Bar>
              <Bar dataKey="NOI" fill={CHART_SERIES.noi} isAnimationActive={false} maxBarSize={54}>
                {showBarLabels && <LabelList dataKey="NOI" position="top" formatter={kfmt} className="bar-label" />}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      )}
    </div>
  );
}

function ChartPanel({ title, caption, wide, children }) {
  return (
    <div className={`chart-panel${wide ? ' wide' : ''}`}>
      <div className="chart-panel-head">
        <strong>{title}</strong>
        {caption && <span className="chart-cap">{caption}</span>}
      </div>
      {children}
    </div>
  );
}
