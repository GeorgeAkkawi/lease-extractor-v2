import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from 'recharts';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, projectedVsLive, rentRollover,
  CHART_SERIES, CHART_LIVE, DONUT_PALETTE, ROLLOVER_RAMP, kfmt, shortName,
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
export default function PortfolioCharts({ properties = [], totalsByProp = {}, basisByProp = null, leases = [], year }) {
  const revenue = revenueByProperty(properties, totalsByProp);
  const space = occupancyByProperty(properties, totalsByProp);
  const performance = projectedVsLive(properties, totalsByProp, basisByProp);
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

  // ⚠ ALL FOUR BARS ALWAYS DRAW NOW, where the old collected bar hid itself when nothing had
  // come in. On a panel whose subject IS the comparison, a live bar sitting at zero against a
  // projected one is the reading, not an empty frame — hiding it would answer "how are we
  // doing against plan?" by removing the half that says badly.
  const barLabel = (key) => (performance.length <= 6
    ? <LabelList dataKey={key} position="top" formatter={kfmt} className="bar-label" />
    : null);

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
              <Tooltip content={<RolloverTip />} cursor={{ fill: 'rgba(27,24,19,.05)' }} />
              <Bar dataKey="value" isAnimationActive={false} maxBarSize={58}>
                {rollover.map((d, i) => <Cell key={d.key} fill={ROLLOVER_RAMP[Math.min(i, ROLLOVER_RAMP.length - 1)]} />)}
                <LabelList dataKey="value" position="top" formatter={kfmt} className="bar-label" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="chart-foot">{rolloverFoot}</p>
        </ChartPanel>
      )}

      {/* Full width: two PAIRS of bars per property, each carrying its own figure. At a
          third of the band the labels would collide — and this is the comparison the other
          three panels lead up to, so it earns the room. */}
      {performance.length > 0 && (
        <ChartPanel
          title="Projected vs live, by property"
          caption={`FY ${year} · rent and costs, contracted against actual`}
          wide
          /* ⚠ Whether the bar figures fit depends on the room ONE property gets, which is
             the plot width divided by the number of properties — so a viewport-only media
             query is the wrong instrument, and labelling every bar collided at exactly
             this panel's 3-property width last round. Measured on the deployed demo: a
             283px per-property slot still clears its labels by 9px, and three properties
             at 1440 get ~339px. `dense` marks the case that can fall under that — three or
             more properties in a narrowed window — so the media query below drops the
             figures there and nowhere else. The hover panel carries all four regardless.
             Still four bars after the 2026-08-18 rebuild, so the measurement holds. */
          className={['has-live', performance.length >= 3 ? 'dense' : ''].filter(Boolean).join(' ')}
        >
          {/* Named in BAR order, so the reader can map each swatch to the column under it —
              and PAIRED in that order too, so the legend reads the way the bars group. */}
          <div className="chart-legend">
            <span><span className="sw" style={{ background: CHART_SERIES.revenue }} /> Projected revenue</span>
            <span><span className="sw" style={{ background: CHART_LIVE.revenue }} /> Live revenue</span>
            <span><span className="sw" style={{ background: CHART_SERIES.expenses }} /> Projected expenses</span>
            <span><span className="sw" style={{ background: CHART_LIVE.expenses }} /> Live expenses</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            {/* ⚠ THE PAIR ONLY READS IF THE TWO BARS TOUCH, and recharts will not do that on
                its own: it divides the property's band by the number of series and then
                CENTRES each bar in its slot, so a maxBarSize small enough to fit four
                scatters them across the band with a hole wherever a figure is $0 — four
                loose columns instead of two pairs, which is the one thing this panel must
                not look like. Narrowing the band (barCategoryGap) and closing the gap
                between bars is what pulls each projected bar against its live twin; the
                size cap is then only a ceiling for a portfolio with one or two properties. */}
            <BarChart
              data={performance}
              margin={{ top: 16, right: 4, left: -8, bottom: 0 }}
              barCategoryGap="24%"
              barGap={2}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,19,.1)" vertical={false} />
              <XAxis dataKey="name" tickFormatter={(v) => shortName(v, 16)} tick={{ fontSize: 10 }} interval={0} />
              <YAxis tickFormatter={kfmt} tick={{ fontSize: 10 }} />
              {/* Custom content, for two reasons: recharts' Tooltip defaults to
                  itemSorter:'name', which would sort the four series ALPHABETICALLY and
                  split both pairs; and the expense rows have to show the actual
                  taxes/CAM/roof they're made of. */}
              <Tooltip content={<PerformanceTip year={year} />} cursor={{ fill: 'rgba(27,24,19,.05)' }} />
              {/* Each live bar is declared IMMEDIATELY after the projected one it belongs to,
                  never grouped at the end: it is the same measure with what actually
                  happened, and the two only read as one thing twice if they stand together. */}
              <Bar dataKey="Projected revenue" fill={CHART_SERIES.revenue} isAnimationActive={false} maxBarSize={50}>
                {barLabel('Projected revenue')}
              </Bar>
              <Bar dataKey="Live revenue" fill={CHART_LIVE.revenue} isAnimationActive={false} maxBarSize={50}>
                {barLabel('Live revenue')}
              </Bar>
              <Bar dataKey="Projected expenses" fill={CHART_SERIES.expenses} isAnimationActive={false} maxBarSize={50}>
                {barLabel('Projected expenses')}
              </Bar>
              <Bar dataKey="Live expenses" fill={CHART_LIVE.expenses} isAnimationActive={false} maxBarSize={50}>
                {barLabel('Live expenses')}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="chart-foot">
            <p className="chart-foot-line">
              <b>Projected</b> is what FY {year} is contracted to do — the rent the leases
              oblige (including a step dated later this year that hasn’t taken effect yet)
              plus the CAM &amp; tax billed at estimate, against the actual property taxes,
              CAM and roof entered on each property’s Expense entry.
            </p>
            <p className="chart-foot-line">
              <b>Live</b> is what has actually happened: money the Ledger says arrived, and
              costs carrying a payment date. Both halves of each pair count the same
              dollars, so the gap between them is the whole reading. Hover a property for
              its figures, what’s left on each basis, and the costs still undated.
            </p>
          </div>
        </ChartPanel>
      )}
    </div>
  );
}

// Which leases sit inside a rollover bar — the question the bar itself raises.
// Exported only so a test can render it: recharts' ResponsiveContainer measures 0×0 in
// jsdom, so nothing inside a chart is ever drawn there and a crash in here would reach
// the browser unseen.
export function RolloverTip({ active, payload }) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;
  const shown = d.leases.slice(0, 6);
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">
        {d.kind === 'now' ? 'Already past its end date' : `Ending in ${d.label}`}
      </div>
      <div className="chart-tip-total">
        {money(d.value)} <span className="muted">· {d.count} lease{d.count === 1 ? '' : 's'}</span>
      </div>
      <ul className="chart-tip-list">
        {shown.map((l) => (
          <li key={l.id}>
            <span className="chart-tip-name">{shortName(l.name, 22)}</span>
            <span className="chart-tip-val">{money0(l.rent)}</span>
          </li>
        ))}
        {d.leases.length > shown.length && (
          <li className="muted">+{d.leases.length - shown.length} more</li>
        )}
      </ul>
    </div>
  );
}

// The two pairs in BAR order, with the projected expenses broken into the actual figures
// they were summed from, what's left on each basis, and the two caveats that would otherwise
// make a figure here lie. Exported for the same reason as RolloverTip.
export function PerformanceTip({ active, payload, label, year }) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;
  const parts = [
    ['Property taxes', d.taxes],
    ['CAM / maintenance', d.cam],
    ['Roof', d.roof],
  ].filter(([, v]) => v > 0);
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{label}{year ? <span className="muted"> · FY {year}</span> : null}</div>
      <ul className="chart-tip-list">
        <li><span className="sw" style={{ background: CHART_SERIES.revenue }} /><span className="chart-tip-name">Projected revenue</span><span className="chart-tip-val">{money(d['Projected revenue'])}</span></li>
        <li><span className="sw" style={{ background: CHART_LIVE.revenue }} /><span className="chart-tip-name">Live revenue</span><span className="chart-tip-val">{money(d['Live revenue'])}</span></li>
        {/* Cash that arrived beyond what a month billed. In NEITHER figure above until the
            landlord answers for it on the Ledger — so if it isn't named here, a reader would
            have no way to tell a short year from an unanswered one. */}
        {d.unapplied > 0.5 && (
          <li className="chart-tip-part">
            <span className="chart-tip-name">+{money(d.unapplied)} awaiting your answer</span>
          </li>
        )}
        <li><span className="sw" style={{ background: CHART_SERIES.expenses }} /><span className="chart-tip-name">Projected expenses</span><span className="chart-tip-val">{money(d['Projected expenses'])}</span></li>
        {parts.map(([name, v]) => (
          <li key={name} className="chart-tip-part">
            <span className="chart-tip-name">{name}</span><span className="chart-tip-val">{money(v)}</span>
          </li>
        ))}
        {parts.length === 0 && <li className="chart-tip-part muted">No expenses entered for this year</li>}
        <li><span className="sw" style={{ background: CHART_LIVE.expenses }} /><span className="chart-tip-name">Live expenses</span><span className="chart-tip-val">{money(d['Live expenses'])}</span></li>
        {/* ⚠ THE ONE THING THAT MAKES "Live expenses" READ AS A CHEAP YEAR. An undated cost
            has not been shown to be unspent — it has been shown to have no day on it. */}
        {d.undatedExpenses > 0.5 && (
          <li className="chart-tip-part">
            <span className="chart-tip-name">{money(d.undatedExpenses)} carries no payment date</span>
          </li>
        )}
        <li><span className="sw" style={{ background: CHART_SERIES.noi }} /><span className="chart-tip-name">What’s left · projected</span><span className="chart-tip-val">{money(d.projectedNet)}</span></li>
        <li><span className="sw" style={{ background: CHART_SERIES.noi }} /><span className="chart-tip-name">What’s left · live</span><span className="chart-tip-val">{money(d.liveNet)}</span></li>
        {/* Quoted last so the panel stays reconcilable with the property pages. NOI counts
            base rent only, where everything above counts the CAM & tax tenants reimburse —
            the same gap "What actually stayed" explains there. */}
        <li className="chart-tip-part">
          <span className="chart-tip-name">NOI (base rent only)</span><span className="chart-tip-val">{money(d.noi)}</span>
        </li>
      </ul>
    </div>
  );
}

function ChartPanel({ title, caption, wide, className = '', children }) {
  return (
    <div className={`chart-panel${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}>
      <div className="chart-panel-head">
        <strong>{title}</strong>
        {caption && <span className="chart-cap">{caption}</span>}
      </div>
      {children}
    </div>
  );
}
