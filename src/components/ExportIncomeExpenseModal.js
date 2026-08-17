import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildIncomeExpense } from '../lib/incomeExpense';
import { downloadIncomeExpenseXlsx } from '../lib/incomeExpenseExcel';
import { money } from '../lib/format';
import { useModalA11y } from './modalA11y';
import StaleBuildNotice from './StaleBuildNotice';

// The one workbook a landlord hands someone — one per entity per year.
//
// It replaced the tax package, the 1099 worksheet and the lender package on 2026-08-12.
// Those three shaped the same figures for a form, a filing deadline and an underwriter;
// this one answers the question underneath all of them, which is what came in, what went
// out and what is left.
//
// ⚠ THE FIGURES ARE ON SCREEN BEFORE ANYTHING DOWNLOADS. A workbook whose contents are
// only knowable by opening it in Excel makes the landlord download it to find out
// whether it was worth downloading. What is previewed here IS what the Summary sheet
// says, from the same built package (`prebuilt`), so the two cannot disagree.
//
// ⚠ TWO BASES SINCE 2026-08-17, and the choice is made HERE rather than remembered. George:
// *"there needs to be a button for the income and expenses to say, hey. I need a live look,
// which uses the real numbers on the ledger and the actual cam and tax … there should be a
// projected at the beginning of the year, which shows any escalations."* It opens on Projected
// every time on purpose — the basis is a decision about the document being produced, not a
// preference about the app, and a remembered one is how somebody hands their accountant the
// wrong copy.
//
// The basis is in the query KEY, so the preview beneath the buttons is the file that will
// download — not a cached copy of the other one.
//
// No AI, no charge. Every figure is read from what the Financials page already shows.
export default function ExportIncomeExpenseModal({ corporationId, corporationName, year, onClose }) {
  const modalRef = useModalA11y(onClose);
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState('projected');
  // The ERROR OBJECT, not its message — StaleBuildNotice needs to know which kind it is.
  const [err, setErr] = useState(null);

  const { data: pkg, isLoading, isError } = useQuery({
    queryKey: ['incomeExpense', corporationId, year, basis],
    queryFn: () => buildIncomeExpense(corporationId, year, { basis }),
  });

  async function download() {
    setErr(null); setBusy(true);
    try {
      await downloadIncomeExpenseXlsx({ corporationId, corporationName, year, basis, prebuilt: pkg });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const t = pkg?.totals;
  const live = basis === 'live';
  const opt = (key, title, blurb) => (
    <label className={`basis-opt${basis === key ? ' on' : ''}`}>
      <input type="radio" name="ie-basis" value={key} checked={basis === key} onChange={() => setBasis(key)} />
      <b>{title}</b>
      <span>{blurb}</span>
    </label>
  );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 660 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Income and expenses · {corporationName || 'entity'} · {year}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            A summary sheet for the whole company, then one sheet per property — laid out month by month,
            January to December, with the year&rsquo;s total on the far right: every component of the money in,
            every expense by category and bucket, what tenants paid back, and what the year left.
          </p>

          {/* ⚠ ABOVE THE PREVIEW, because it changes what every figure below it means. */}
          <div className="basis-pick">
            {opt('projected', 'Projected',
              'The year as the leases contract it — every month billed, including rent steps that have not taken effect yet, and CAM & tax at the estimate.')}
            {opt('live', 'Live',
              'What actually happened — money the Ledger says arrived, month by month, and the tenants’ real CAM & tax share. Months nothing came in on are blank.')}
          </div>

          {isLoading && <p className="muted" style={{ marginTop: 14 }}>Reading your figures…</p>}
          {isError && <p className="note-msg danger" style={{ marginTop: 14 }}>Could not read the figures for {year}.</p>}

          {pkg && t && (
            <>
              <div className="fin-subhead" style={{ marginTop: 16 }}>
                {pkg.properties.length} propert{pkg.properties.length === 1 ? 'y' : 'ies'}
                <span className="muted"> · {live ? 'live' : 'projected'}</span>
              </div>
              {/* ⚠ THE SUMMARY SHEET'S OWN MONEY-IN ROWS, IN THE SAME ORDER. This preview
                  showed "Rent" alone until the 2026-08-16 audit — which was the whole of
                  Money in until that morning and 23% of it afterwards, under a sentence
                  ("the reimbursement is taken off the cost rather than added to the rent")
                  that had stopped being true in the same commit. A preview that describes
                  a layout the workbook no longer has is worse than none: it is the figure
                  the landlord checks the download against. */}
              <div className="export-pre">
                <div><span className="muted">{live ? 'Rent collected' : 'Rent'}</span><b className="pos">{money(t.rent)}</b></div>
                {Math.abs(t.camTaxBilled) > 0.005 && (
                  <div><span className="muted">CAM &amp; tax {live ? 'collected' : 'billed'}</span><b className="pos">{money(t.camTaxBilled)}</b></div>
                )}
                {Math.abs(t.roofBilled) > 0.005 && (
                  <div><span className="muted">Roof {live ? 'collected' : 'billed'}</span><b className="pos">{money(t.roofBilled)}</b></div>
                )}
                {Math.abs(t.charges) > 0.005 && (
                  <div><span className="muted">Charges &amp; credits</span><b className={t.charges < 0 ? 'neg' : 'pos'}>{money(t.charges)}</b></div>
                )}
                {/* In Total billed, out again below — the one row on the sheet that appears
                    twice with opposite signs, because it is money the tenant owes and is not
                    this year's income. */}
                {Math.abs(t.carried) > 0.005 && (
                  <div><span className="muted">Brought forward &amp; refunds</span><b className={t.carried < 0 ? 'neg' : 'pos'}>{money(t.carried)}</b></div>
                )}
                <div><span className="muted">Other income</span><b className="pos">{money(t.otherIncome)}</b></div>
                {/* ⚠ THE FIGURE THAT TIES TO THE LEDGER, and the first draft of this preview
                    left it out. Every month above it is what tenants were billed, so this
                    total is the one number a landlord can hold against the Ledger's own
                    "of $X billed" — which is exactly what the sheet is for. */}
                <div><span className="muted">{live ? 'Total collected' : 'Total billed'}</span><b className="pos">{money(t.billedTotal)}</b></div>
                {Math.abs(t.carried) > 0.005 && (
                  <div><span className="muted">Less brought forward &amp; refunds</span><b className={t.carried > 0 ? 'neg' : 'pos'}>{money(-t.carried)}</b></div>
                )}
                {Math.abs(t.trueUp) > 0.005 && (
                  <div><span className="muted">{live ? 'CAM & tax — actual share, less what came in' : 'Year-end reconciliation'}</span><b className={t.trueUp < 0 ? 'neg' : 'pos'}>{money(t.trueUp)}</b></div>
                )}
                {/* Only when it differs from Total billed above — otherwise the preview
                    prints the same figure twice under two names, which reads as an error. */}
                {(Math.abs(t.trueUp) > 0.005 || Math.abs(t.carried) > 0.005) && (
                  <div><span className="muted">Total earned</span><b className="pos">{money(t.earned)}</b></div>
                )}
                <div><span className="muted">Less what you spent</span><b className="neg">{money(-t.spent)}</b></div>
                <div><span className="muted">What the year left</span><b>{money(t.net)}</b></div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {live
                  ? <>Each month is money the Ledger says actually arrived; a month nothing came in on is blank. Of the {money(t.spent)} you
                    spent, {money(t.recovered)} is the tenants&rsquo; real share — the line above is that share less what they have paid toward it.</>
                  : <>Each month is what tenants were billed that month — the same figure the Ledger and the invoice show.
                    Of the {money(t.spent)} you spent, {money(t.recovered)} is the tenants&rsquo; share; they pay an estimate
                    through the year and the difference is settled once, on the year-end line.</>}
              </div>

              {/* ⚠ SAID BEFORE THE DOWNLOAD, NOT DISCOVERED INSIDE IT. A monthly sheet
                  invites the reader to scan across the year, so how much of the year is
                  NOT on the grid is the one thing they have to be told first. */}
              {/* ⚠ THE UNDATED SENTENCE LIVED HERE AND HAS MOVED INTO `flags()`. It said the
                  same total, in nearly the same words, immediately above the flag list that
                  says it again — two paragraphs of the same fact in one small dialog. The
                  flag is the copy that also reaches the workbook, where nobody can ask, so
                  the explanation went there and this went away. Do not put it back. */}

              {/* Owner money, stated apart — the same rule the screen and the sheet follow. */}
              {t.distributions > 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Listed separately, in none of the figures above: {money(t.distributions)} you took out.
                </div>
              )}

              {pkg.flags.length > 0 && (
                <div className="export-flags" style={{ marginTop: 14 }}>
                  {pkg.flags.map((f, i) => <div className="export-flag" key={i}>{f}</div>)}
                </div>
              )}

              {pkg.properties.length === 0 && (
                <p className="note-msg warn" style={{ marginTop: 14 }}>
                  This company has no properties, so the workbook would be empty.
                </p>
              )}
            </>
          )}

          <StaleBuildNotice error={err} />
        </div>
        <div className="modal-foot">
          <button className="secondary" onClick={onClose}>Close</button>
          <button onClick={download} disabled={busy || isLoading || !pkg || pkg.properties.length === 0}>
            {busy ? 'Building…' : `⬇ Download the ${live ? 'live' : 'projected'} workbook`}
          </button>
        </div>
      </div>
    </div>
  );
}
