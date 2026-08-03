import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from 'recharts';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, revenueExpensesNoi, rentRollover,
  hasCollectedBars, CHART_SERIES, CHART_COLLECTED, DONUT_PALETTE, ROLLOVER_RAMP, kfmt, shortName,
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
export default function PortfolioCharts({ properties = [], totalsByProp = {}, collectedByProp = null, leases = [], year }) {
  const revenue = revenueByProperty(properties, totalsByProp);
  const space = occupancyByProperty(properties, totalsByProp);
  const performance = revenueExpensesNoi(properties, totalsByProp, collectedByProp);
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

  // The collected bar hides itself entirely when nothing has come in: a flat zero against
  // every property would say nothing and cost the other three bars their width.
  const showCollected = hasCollectedBars(performance);
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

      {/* Full width: three grouped bars per property, each carrying its own figure. At a
          third of the band the labels would collide — and this is the comparison the other
          three panels lead up to, so it earns the room. */}
      {performance.length > 0 && (
        <ChartPanel
          title="What each property keeps"
          caption={showCollected
            ? `FY ${year} · with the rent collected so far`
            : `Revenue · expenses · NOI · FY ${year}`}
          wide
          /* ⚠ Whether the bar figures fit depends on the room ONE property gets, which is
             the plot width divided by the number of properties — so a viewport-only media
             query is the wrong instrument, and labelling every bar collided at exactly
             this panel's 3-property width last round. Measured on the deployed demo: a
             283px per-property slot still clears its labels by 9px, and three properties
             at 1440 get ~339px. `dense` marks the case that can fall under that — three or
             more properties in a narrowed window — so the media query below drops the
             figures there and nowhere else. The hover panel carries all four regardless. */
          className={[
            showCollected ? 'has-collected' : '',
            showCollected && performance.length >= 3 ? 'dense' : '',
          ].filter(Boolean).join(' ')}
        >
          {/* Named in BAR order, so the reader can map each swatch to the column under it. */}
          <div className="chart-legend">
            <span><span className="sw" style={{ background: CHART_SERIES.revenue }} /> Revenue</span>
            {showCollected && (
              <span><span className="sw" style={{ background: CHART_COLLECTED }} /> Collected so far</span>
            )}
            <span><span className="sw" style={{ background: CHART_SERIES.expenses }} /> Expenses</span>
            <span><span className="sw" style={{ background: CHART_SERIES.noi }} /> NOI</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            {/* ⚠ THE PAIR ONLY READS IF THE TWO BARS TOUCH, and recharts will not do that on
                its own: it divides the property's band by the number of series and then
                CENTRES each bar in its slot, so a maxBarSize small enough to fit four
                scatters them across the band with a hole wherever a figure is $0 — four
                loose columns instead of a pair and two singles, which is the one thing this
                panel must not look like. Narrowing the band (barCategoryGap) and closing
                the gap between bars is what pulls Revenue and Collected together; the size
                cap is then only a ceiling for a portfolio with one or two properties. */}
            <BarChart
              data={performance}
              margin={{ top: 16, right: 4, left: -8, bottom: 0 }}
              barCategoryGap={showCollected ? '24%' : '10%'}
              barGap={showCollected ? 2 : 4}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,19,.1)" vertical={false} />
              <XAxis dataKey="name" tickFormatter={(v) => shortName(v, 16)} tick={{ fontSize: 10 }} interval={0} />
              <YAxis tickFormatter={kfmt} tick={{ fontSize: 10 }} />
              {/* Custom content, for two reasons: recharts' Tooltip defaults to
                  itemSorter:'name', which sorted the three series ALPHABETICALLY —
                  Expenses · NOI · Revenue — reading as though NOI came out of expenses;
                  and the Expenses row has to show the actual taxes/CAM/roof it's made of. */}
              <Tooltip content={<PerformanceTip year={year} />} cursor={{ fill: 'rgba(27,24,19,.05)' }} />
              {/* Collected is declared immediately after Revenue, never at the end: it is
                  the same measure with money actually in hand, and the two only read as one
                  thing twice if they stand next to each other. */}
              <Bar dataKey="Revenue" fill={CHART_SERIES.revenue} isAnimationActive={false} maxBarSize={showCollected ? 50 : 54}>
                {barLabel('Revenue')}
              </Bar>
              {showCollected && (
                <Bar dataKey="Collected" fill={CHART_COLLECTED} isAnimationActive={false} maxBarSize={50}>
                  {barLabel('Collected')}
                </Bar>
              )}
              <Bar dataKey="Expenses" fill={CHART_SERIES.expenses} isAnimationActive={false} maxBarSize={showCollected ? 50 : 54}>
                {barLabel('Expenses')}
              </Bar>
              <Bar dataKey="NOI" fill={CHART_SERIES.noi} isAnimationActive={false} maxBarSize={showCollected ? 50 : 54}>
                {barLabel('NOI')}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {showCollected ? (
            <div className="chart-foot">
              <p className="chart-foot-line">
                Revenue, Expenses and NOI are what FY {year} comes to <b>on paper</b> — the rent
                the leases oblige, and the actual property taxes, CAM and roof entered on each
                property’s Expense entry, not the CAM &amp; tax estimates billed to tenants.
              </p>
              <p className="chart-foot-line">
                <b>Collected so far</b> is money that has actually arrived: payments recorded
                against this year’s invoices, straight off the Ledger. It is <b>all-in</b> — it
                includes the CAM &amp; tax your tenants reimburse, which Revenue doesn’t count —
                so it is not a share of the Revenue bar and can read above it.
              </p>
            </div>
          ) : (
            <p className="chart-foot">
              Expenses are the actual property taxes, CAM and roof entered on each property’s
              Expense entry for FY {year} — not the CAM &amp; tax estimates billed to tenants.
              Hover a property to see the three figures.
            </p>
          )}
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

// Revenue · Collected · Expenses · NOI, in bar order, with the expenses broken into the
// actual figures they were summed from and the collected figure carrying what it is a
// share OF. Exported for the same reason as RolloverTip.
export function PerformanceTip({ active, payload, label, year }) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;
  const parts = [
    ['Property taxes', d.taxes],
    ['CAM / maintenance', d.cam],
    ['Roof', d.roof],
  ].filter(([, v]) => v > 0);
  const collected = d.Collected != null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{label}{year ? <span className="muted"> · FY {year}</span> : null}</div>
      <ul className="chart-tip-list">
        <li><span className="sw" style={{ background: CHART_SERIES.revenue }} /><span className="chart-tip-name">Revenue</span><span className="chart-tip-val">{money(d.Revenue)}</span></li>
        {collected && (
          <>
            <li>
              <span className="sw" style={{ background: CHART_COLLECTED }} />
              <span className="chart-tip-name">Collected so far</span>
              <span className="chart-tip-val">{money(d.Collected)}</span>
            </li>
            {/* What the figure is a share OF, then the reason it isn't a share of Revenue.
                Two rows rather than one: .chart-tip-name truncates, and either half is
                worth more than half a sentence with an ellipsis on the end. */}
            <li className="chart-tip-part">
              <span className="chart-tip-name">
                {d.billedYtd > 0 ? `of ${money(d.billedYtd)} billed` : 'nothing billed yet this year'}
              </span>
            </li>
            {d.Collected > 0 && (
              <li className="chart-tip-part">
                <span className="chart-tip-name">incl. reimbursed CAM &amp; tax</span>
              </li>
            )}
          </>
        )}
        <li><span className="sw" style={{ background: CHART_SERIES.expenses }} /><span className="chart-tip-name">Expenses</span><span className="chart-tip-val">{money(d.Expenses)}</span></li>
        {parts.map(([name, v]) => (
          <li key={name} className="chart-tip-part">
            <span className="chart-tip-name">{name}</span><span className="chart-tip-val">{money(v)}</span>
          </li>
        ))}
        {parts.length === 0 && <li className="chart-tip-part muted">No expenses entered for this year</li>}
        <li><span className="sw" style={{ background: CHART_SERIES.noi }} /><span className="chart-tip-name">NOI</span><span className="chart-tip-val">{money(d.NOI)}</span></li>
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
