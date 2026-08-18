import { Link } from 'react-router-dom';
import { money, money0 } from '../lib/format';
import { CHART_SERIES, CHART_LIVE } from '../lib/portfolioCharts';

// The Overview's headline: what FY {year} is contracted to do, and what has actually
// happened, side by side.
//
// George, 2026-08-18: *"weve built thi software around projected but there should be a live
// counter as well … as a matter of fact that should be way more prominent in the overview
// page graphs."* So it sits ABOVE the chart band rather than inside it — it is the sentence
// the four panels below elaborate on.
//
// ⚠ EVERY FIGURE HERE IS A PAIR, AND BOTH HALVES COUNT THE SAME DOLLARS. That is the repair,
// not a presentation choice: the panel this replaces put base-rent-only Revenue beside all-in
// Collected and then had to print two paragraphs explaining why the second could read above
// the first. See `projectedVsLive` (portfolioCharts.js) for what each side is built from.
//
// ⚠ AND THE TWO THINGS THAT WOULD MAKE A FIGURE HERE LIE ARE STATED, NOT SWALLOWED. Undated
// costs are in Projected and in no Live figure; an unanswered over-payment is in neither. A
// band that quietly dropped either would be most convincing exactly when it was most wrong,
// so each gets its own line and a link to the screen where it is fixed.
export default function BasisBand({ totals, year, ledgerHref = null, financialsHref = null }) {
  if (!totals) return null;
  const { revenue, expenses, net, undatedExpenses, unapplied, loading } = totals;

  // Nothing contracted and nothing collected — a band of dashes claiming to be a reading.
  if (!loading && revenue.projected === 0 && revenue.live === 0 && expenses.projected === 0) return null;

  return (
    <div className={`basis-band${loading ? ' is-loading' : ''}`}>
      <div className="basis-band-head">
        <strong>FY {year} · projected vs live</strong>
        <span className="chart-cap">
          What your leases contract, against what has actually happened
        </span>
      </div>

      <div className="basis-cols">
        <BasisCol
          label="Revenue"
          pair={revenue}
          ink={CHART_SERIES.revenue}
          liveInk={CHART_LIVE.revenue}
          /* "in" and "out" rather than a bare percentage: 31% of the expenses being spent is
             good news and 31% of the rent being in is not, and the same number cannot carry
             both meanings on one row. */
          shareWord="in"
          loading={loading}
        />
        <BasisCol
          label="Expenses"
          pair={expenses}
          ink={CHART_SERIES.expenses}
          liveInk={CHART_LIVE.expenses}
          shareWord="paid"
          loading={loading}
        />
        <BasisCol
          label="What’s left"
          pair={net}
          ink={CHART_SERIES.noi}
          liveInk={CHART_SERIES.noi}
          shareWord={null}
          loading={loading}
        />
      </div>

      <div className="basis-foot">
        <p className="chart-foot-line">
          <b>Projected</b> is what your leases oblige for the whole year — base rent
          (including a rent step dated later this year that hasn’t taken effect yet) plus the
          CAM &amp; tax you bill at estimate — against the property taxes, CAM and roof
          entered on each Expense entry. <b>Live</b> is what has actually happened: money the
          Ledger says arrived, and costs carrying a payment date.
        </p>
        {/* ⚠ THE ONE THING THAT CAN MAKE "Live expenses" READ AS A CHEAP YEAR. An undated cost
            has not been shown to be unspent — it has been shown to have no day on it. */}
        {undatedExpenses > 0.5 && (
          <p className="chart-foot-line basis-caveat">
            <b>{money(undatedExpenses)}</b> of costs carry no payment date, so they are in
            Projected expenses and in no Live figure.{' '}
            {financialsHref
              ? <Link to={financialsHref}>Date them on the Expense entry</Link>
              : 'Date them on each property’s Expense entry'} to bring them in.
          </p>
        )}
        {unapplied > 0.5 && (
          <p className="chart-foot-line basis-caveat">
            <b>{money(unapplied)}</b> arrived beyond what those months billed and is counted in
            nothing here until you say what it is.{' '}
            {ledgerHref ? <Link to={ledgerHref}>Answer it on the Ledger</Link> : 'Answer it on the Ledger'}.
          </p>
        )}
        <p className="chart-foot-line">
          <b>What’s left</b> is revenue less expenses on each basis. It counts the CAM &amp; tax
          your tenants reimburse, which NOI on the property pages does not — the same gap the
          “What actually stayed” strip there explains. Both are right; they answer different
          questions.
        </p>
      </div>
    </div>
  );
}

// One measure, both readings, and the gap between them — in that order, because the gap is
// the thing being asked for and a reader should not have to subtract to find it.
function BasisCol({ label, pair, ink, liveInk, shareWord, loading }) {
  const { projected, live, delta, share } = pair;
  // Clamped for the TRACK only. A live figure above its projection is real and is printed in
  // full above; a bar drawn past its own frame just looks broken.
  const pct = share == null ? 0 : Math.max(0, Math.min(1, share)) * 100;
  const pctLabel = share == null ? null : Math.round(share * 100);
  return (
    <div className="basis-col">
      <div className="basis-col-label">{label}</div>
      <div className="basis-figs">
        <div className="basis-fig">
          <span className="basis-sw" style={{ background: ink }} />
          <span className="basis-amt">{money0(projected)}</span>
          <span className="basis-cap">projected</span>
        </div>
        <div className="basis-fig">
          <span className="basis-sw" style={{ background: liveInk }} />
          <span className="basis-amt live">{loading ? '—' : money0(live)}</span>
          <span className="basis-cap">live</span>
        </div>
      </div>
      <div
        className="basis-track"
        title={pctLabel == null ? undefined : `${money(live)} of ${money(projected)}`}
        aria-hidden="true"
      >
        <span style={{ width: `${loading ? 0 : pct}%`, background: liveInk }} />
      </div>
      <div className="basis-delta">
        {loading ? (
          <span className="muted">reading the Ledger…</span>
        ) : (
          <>
            <b className={delta < -0.5 ? 'neg' : delta > 0.5 ? 'pos' : ''}>
              {delta > 0.5 ? '+' : delta < -0.5 ? '−' : ''}{money(Math.abs(delta))}
            </b>
            {pctLabel != null && shareWord && <span className="muted"> · {pctLabel}% {shareWord}</span>}
          </>
        )}
      </div>
    </div>
  );
}
