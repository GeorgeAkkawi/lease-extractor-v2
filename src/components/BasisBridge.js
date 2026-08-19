import { Link } from 'react-router-dom';
import Panel from './Panel';
import { money } from '../lib/format';

// The band says the two readings differ. This says why.
//
// George, 2026-08-18: *"at the end of the year it should give a summary of any differences in
// the numbers and where they came from for the projected vs live stats"*.
//
// ⚠ THE ANSWER, THEN THE WORKING — and folded, it is still the answer. `Panel`'s rule is that a
// folded section states what it holds, and here that is the whole point: a landlord who never
// opens this should still learn that the year is $54,000 short and that almost all of it is rent
// nobody has paid yet. The terms are what you open it for.
//
// ⚠ IT COMPUTES NOTHING. Every figure and every label comes from `yearBridge`, which is where
// the arithmetic is tested. A component that did its own rounding or its own summing would be a
// second answer to the question the band above it is already answering (CLAUDE.md §3).
export default function BasisBridge({ bridge, year, ledgerHref = null, incomeHref = null }) {
  if (!bridge || !bridge.headline) return null;
  const { headline, measures, caveats } = bridge;
  const linkFor = (key) => (key === 'ledger' ? ledgerHref : key === 'income' ? incomeHref : null);

  return (
    <Panel
      id="overview.basisBridge"
      defaultOpen={false}
      bare
      headClass="basis-bridge-head"
      className="basis-bridge"
      title={`FY ${year} · where the difference is`}
      summary={summaryLine(headline)}
      hint={summaryLine(headline)}
    >
      <div className="basis-bridge-body">
        {measures.map((m) => (
          <MeasureBlock key={m.key} m={m} linkFor={linkFor} />
        ))}

        {caveats.length > 0 && (
          <div className="basis-bridge-caveats">
            {/* ⚠ NOT TERMS, AND THE HEADING SAYS SO. A term explains the gap; these are money the
                gap does not know about — which is exactly why each one asks the landlord to go
                and do something, and carries somewhere to go. */}
            <p className="basis-bridge-caveat-head">In none of the figures above</p>
            {caveats.map((c) => {
              const href = linkFor(c.link);
              return (
                <p key={c.key} className="chart-foot-line basis-caveat">
                  <b>{money(Math.abs(c.amount))}</b> {c.label}
                  {c.rows.length > 1 && <span className="basis-term-rows"> — {evidence(c.rows)}</span>}
                  {'. '}
                  {href ? <Link to={href}>{c.action}</Link> : c.action}.
                </p>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

function MeasureBlock({ m, linkFor }) {
  const pctLabel = m.share == null ? null : Math.round(m.share * 100);
  return (
    <div className="basis-bridge-measure">
      <div className="basis-bridge-measure-head">
        <span className="basis-bridge-measure-name">
          {m.label}
          <span className="basis-col-sub">{m.sub}</span>
        </span>
        <span className="basis-bridge-measure-figs">
          {money(m.projected)} <span className="basis-cap">projected</span>
          {' · '}
          {money(m.live)} <span className="basis-cap">live</span>
          {pctLabel != null && <span className="muted"> · {pctLabel}% in</span>}
        </span>
        <b className={`basis-bridge-delta${m.delta < -0.5 ? ' neg' : m.delta > 0.5 ? ' pos' : ''}`}>
          {m.delta > 0.5 ? '+' : m.delta < -0.5 ? '−' : ''}{money(Math.abs(m.delta))}
        </b>
      </div>

      {m.terms.length === 0 ? (
        // ⚠ "NOTHING TO EXPLAIN" IS A REAL ANSWER, and it is not the same as a blank space.
        // A measure with no causes and no gap has been checked; one with no figures at all has
        // not. The first sentence is only reachable when the two columns genuinely agree.
        <p className="basis-bridge-none muted">
          {m.projected <= 0.005 && m.live <= 0.005
            ? 'Nothing was billed under this heading, so there is nothing to compare.'
            : 'Every dollar billed under this heading has come in.'}
        </p>
      ) : (
        <ul className="basis-bridge-terms">
          {m.terms.map((t) => {
            const href = linkFor(t.link);
            return (
              <li key={t.key} className={t.unexplained ? 'is-unexplained' : undefined}>
                <span className={`basis-term-amt${t.amount < 0 ? ' neg' : ' pos'}`}>
                  {t.amount < 0 ? '−' : '+'}{money(Math.abs(t.amount))}
                </span>
                <span className="basis-term-label">
                  {t.label}
                  {/* One property is not a list — its name is already the only answer, so a
                      trailing chip repeating it is noise. Named from two upwards. */}
                  {t.rows.length > 1 && <span className="basis-term-rows">{evidence(t.rows)}</span>}
                  {href && <> · <Link to={href}>see where it came from</Link></>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * `Pershing Plaza $31,000 · Cedar Court $17,200` — the properties behind one cause.
 *
 * ⚠ A ROW THAT PULLS THE OTHER WAY MUST SHOW ITS SIGN (George, 2026-08-18: *"tell me where that
 * figure comes from '3,977.85'"* — a figure the app never printed). The annual-rate caveat on his
 * FY 2026 read `$939.25 · Pershing Plaza $3,956.23 · 401 S Main $3,038.60 · Joliet $21.62`, every
 * row stripped to its absolute value. 401 S Main is **−$3,038.60** — it is the only property whose
 * scheduled rent runs AHEAD of the annual rate — so the three do net to $939.25, but nothing on
 * the line said so. Read as printed, the two that agree sum to $3,977.85 and the headline looks
 * like it came from nowhere.
 *
 * Signs appear only when the rows are MIXED. Where every property pulls the same way as the
 * headline — the common case, and every arrears line — a column of identical minus signs adds
 * nothing and costs the line its readability.
 */
function evidence(rows = []) {
  const mixed = rows.some((r) => r.amount < 0) && rows.some((r) => r.amount > 0);
  return rows
    .map((r) => `${r.label} ${mixed ? (r.amount < 0 ? '−' : '+') : ''}${money(Math.abs(r.amount))}`)
    .join(' · ');
}

/** The one sentence the folded panel carries. */
function summaryLine({ projected, live, delta, direction, cause }) {
  if (direction === 'even') return `${money(projected)} billed and all of it in`;
  const gap = `${money(Math.abs(delta))} ${direction}`;
  // "Most of it is …" is only said when it genuinely is most of it — `yearBridge` withholds
  // `cause` otherwise rather than letting the summary overstate one line.
  const because = cause ? ` — mostly ${firstClause(cause.label)}` : '';
  return `${money(projected)} billed, ${money(live)} in · ${gap}${because}`;
}

/** A term's label is written to stand alone in a list and can run long; the summary takes the
 *  clause before the first em dash, comma or semicolon so a fold stays one line. */
const firstClause = (label = '') => String(label).split(/\s+—\s+|[;,]/)[0].trim();
