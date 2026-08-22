import { money, money0 } from '../lib/format';
import { CHART_SERIES, CHART_LIVE } from '../lib/portfolioCharts';
import { localDateIso } from '../lib/api';
import BasisBridge from './BasisBridge';

// The Overview's headline: the year's BILL, and what has actually come in against it.
//
// George, 2026-08-18: *"projected revenue should be just base rent · projected expenses is the
// estimated cam and tax — then there should be a total collumn instead of the whats left."*
//
// ⚠ WHY THIS IS THE SECOND VERSION, because the first one's fault is the whole reason for the
// shape. It put an ALL-IN projected revenue here — base rent plus the CAM & tax estimate,
// prorated to term — which read $1,155,141 while the donut immediately below said $1,032,564
// for the same portfolio and the same year. Both figures were defensible; neither said which
// it was; and George's first question was exactly the right one: *"where is this coming from."*
//
// So Revenue is THE DONUT'S OWN FIGURE and the two agree to the cent. Expenses is the CAM & tax
// the leases bill at estimate. Total is the two together, which is what the tenant is actually
// charged. A subtraction ("what's left") becomes an addition only when the columns genuinely add,
// and these do: they are the two halves of one invoice.
//
// ⚠ WHAT THAT SHARED FIGURE IS CHANGED ON 2026-08-18 (3), AND THE DONUT CHANGED WITH IT. Both
// used to read `v_property_totals.total_revenue`; both now read `rentProjected` — the leases'
// own months, each applied raise dated, plus a raise scheduled for later this year. George:
// *"we should make rent projections part of the projected rent because we know what those
// numbers are so that shouldn't be a discrepancy."* Moving one and not the other would have
// re-opened the exact gap this band was built to close, which is why it was never an option.
//
// ⚠ AND THE ONE FIGURE THAT IS IN TOTAL AND IN NO COLUMN ABOVE IT IS NAMED. Other income
// (0078 — parking, storage, a write-in) rides no invoice and the app forecasts none of it, so
// it can only land on the live side. Total live has to equal the bank, so it goes IN; and a
// Total that silently outgrew the two columns above it would be the same unexplained figure
// all over again, so it is stated. That is George's own question answered rather than dodged.
//
// ⚠ THE FOOT'S TWO CAVEAT SENTENCES MOVED INTO `BasisBridge` (2026-08-18) rather than being
// copied there. Other income and unapplied cash were hand-written here AND are terms the bridge
// derives per property, and two sentences quoting one figure from two sources is the §3 drift
// this codebase keeps losing an afternoon to. The bridge says both, with the properties behind
// them, and this keeps only the sentence that says what the two columns MEAN — which the bridge
// does not repeat.
// ⚠ `anchorRef` / `flashing` exist so the Ledger can point AT this band (2026-08-21 (11)):
// answering a surplus says the money is in the live income figures, and this is the only
// place on screen those figures are shown. The ref is on the root rather than a wrapper
// div so the band's own layout is untouched.
export default function BasisBand({ totals, bridge = null, year, ledgerHref = null, incomeHref = null, anchorRef = null, flashing = false }) {
  if (!totals) return null;
  const { rent, camTax, total, loading } = totals;

  // Nothing billed and nothing in — a band of dashes claiming to be a reading.
  if (!loading && total.projected === 0 && total.live === 0) return null;

  // What "live" is counted THROUGH, said on the band itself (George, 2026-08-18: live *"is just
  // a running counter taken from the bank statements as the year goes along"*). Projected is the
  // whole year; live is the year so far — without the date, the gap between them reads as rent
  // nobody paid rather than months that have not happened. Only the running year needs it: a
  // past year's live side IS the whole year, and a date there would imply it might still move.
  const todayIso = localDateIso();
  const running = Number(String(todayIso).slice(0, 4)) === Number(year);
  const asOf = running
    ? new Date(`${todayIso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className={`basis-band${loading ? ' is-loading' : ''}${flashing ? ' panel-flash' : ''}`} ref={anchorRef}>
      <div className="basis-band-head">
        <strong>FY {year} · projected vs live</strong>
        <span className="chart-cap">What your leases bill, against what has come in</span>
      </div>

      <div className="basis-cols">
        <BasisCol
          label="Revenue"
          sub="base rent"
          pair={rent}
          ink={CHART_SERIES.revenue}
          liveInk={CHART_LIVE.revenue}
          loading={loading}
        />
        <BasisCol
          label="Expenses"
          sub="CAM & tax billed"
          pair={camTax}
          ink={CHART_SERIES.expenses}
          liveInk={CHART_LIVE.expenses}
          loading={loading}
        />
        <BasisCol
          label="Total"
          sub="what tenants are charged"
          pair={total}
          ink={CHART_SERIES.noi}
          liveInk={CHART_SERIES.noi}
          loading={loading}
        />
      </div>

      <div className="basis-foot">
        <p className="chart-foot-line">
          <b>Projected</b> is the whole year as your leases bill it — base rent month by month, each
          raise from the date it takes effect, plus the CAM, tax and roof you charge at estimate.
          A raise your leases schedule for later this year is counted, and named below.{' '}
          {/* No "same rent as the donut" sentence — third phrasing in three rounds, retired at
              George's word (2026-08-18 (12)). The identity is structural (one `rentProjected`
              reaches both) and pinned in dashboardOverview.test.js; prose restating a
              guarantee the code enforces is the §3 drift risk with none of the payoff. */}
          <b>Live</b> is what has actually arrived, straight off the Ledger
          {/* The date and nothing more. This sentence used to add "so most of the gap is simply
              months still to come" — usually true in August and flatly false in an arrears-heavy
              December. The bridge below MEASURES that split and says "mostly …" only when it is
              so; a blanket claim above it was the prose §3 warns about. */}
          {asOf ? <> — counted through <b>{asOf}</b></> : null}.
        </p>
        <BasisBridge bridge={bridge} year={year} ledgerHref={ledgerHref} incomeHref={incomeHref} />
      </div>
    </div>
  );
}

// One measure, both readings, and the gap between them — in that order, because the gap is
// what was asked for and a reader should not have to subtract to find it.
function BasisCol({ label, sub, pair, ink, liveInk, loading }) {
  const { projected, live, delta, share } = pair;
  // Clamped for the TRACK only. A live figure above its projection is real and is printed in
  // full above; a bar drawn past its own frame just looks broken.
  const pct = share == null ? 0 : Math.max(0, Math.min(1, share)) * 100;
  const pctLabel = share == null ? null : Math.round(share * 100);
  return (
    <div className="basis-col">
      <div className="basis-col-label">
        {label}
        {/* The word George uses, and then the figure it actually is — "Expenses" alone would
            leave a landlord unable to tell the CAM & tax he BILLS from the CAM & tax he pays. */}
        <span className="basis-col-sub">{sub}</span>
      </div>
      <div className="basis-figs">
        <div className="basis-fig">
          <span className="basis-sw" style={{ background: ink }} />
          {/* ⚠ "NOT YET" IS NOT "$0" — the donut's own rule (dashboardOverview.test.js), and
              since Revenue moved off the view (2026-08-18 (3)) it binds this column too: both
              readings now wait on the Ledger roll, so an ungated figure here paints $0 and
              revises it a beat later. The live figure beside it has always worn this dash. */}
          <span className="basis-amt">{loading ? '—' : money0(projected)}</span>
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
            {pctLabel != null && <span className="muted"> · {pctLabel}% in</span>}
          </>
        )}
      </div>
    </div>
  );
}
