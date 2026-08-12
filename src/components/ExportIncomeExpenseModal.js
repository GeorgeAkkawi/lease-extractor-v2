import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildIncomeExpense } from '../lib/incomeExpense';
import { downloadIncomeExpenseXlsx } from '../lib/incomeExpenseExcel';
import { money } from '../lib/format';
import { useModalA11y } from './modalA11y';

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
// No AI, no charge. Every figure is read from what the Financials page already shows.
export default function ExportIncomeExpenseModal({ corporationId, corporationName, year, onClose }) {
  const modalRef = useModalA11y(onClose);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: pkg, isLoading, isError } = useQuery({
    queryKey: ['incomeExpense', corporationId, year],
    queryFn: () => buildIncomeExpense(corporationId, year),
  });

  async function download() {
    setErr(''); setBusy(true);
    try {
      await downloadIncomeExpenseXlsx({ corporationId, corporationName, year, prebuilt: pkg });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not build the workbook — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const t = pkg?.totals;

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
            January to December: rent and other income, every expense by category and bucket, what tenants
            paid back, and what the year left.
          </p>

          {isLoading && <p className="muted" style={{ marginTop: 14 }}>Reading your figures…</p>}
          {isError && <p className="note-msg danger" style={{ marginTop: 14 }}>Could not read the figures for {year}.</p>}

          {pkg && t && (
            <>
              <div className="fin-subhead" style={{ marginTop: 16 }}>
                {pkg.properties.length} propert{pkg.properties.length === 1 ? 'y' : 'ies'}
              </div>
              <div className="export-pre">
                <div><span className="muted">Rent</span><b className="pos">{money(t.rent)}</b></div>
                <div><span className="muted">Other income</span><b className="pos">{money(t.otherIncome)}</b></div>
                <div><span className="muted">Your net cost</span><b className="neg">{money(t.netCost)}</b></div>
                <div><span className="muted">What the year left</span><b>{money(t.net)}</b></div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                You spent {money(t.spent)}; tenants reimbursed {money(t.recovered)} of it through their share.
                The reimbursement is taken off the cost rather than added to the rent, so no dollar is counted twice.
              </div>

              {/* ⚠ SAID BEFORE THE DOWNLOAD, NOT DISCOVERED INSIDE IT. A monthly sheet
                  invites the reader to scan across the year, so how much of the year is
                  NOT on the grid is the one thing they have to be told first. */}
              {(t.outUndated > 0 || t.inUndated > 0) && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {money(t.outUndated + t.inUndated)} has no date on it and lands in a <em>No date</em> column
                  rather than in a month — an expense typed by hand with the date left blank, a figure entered
                  as one annual total, or a cost carried in from a service contract.
                </div>
              )}

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

          {err && <p className="note-msg danger" style={{ marginTop: 12 }}>{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="secondary" onClick={onClose}>Close</button>
          <button onClick={download} disabled={busy || isLoading || !pkg || pkg.properties.length === 0}>
            {busy ? 'Building…' : '⬇ Download Excel'}
          </button>
        </div>
      </div>
    </div>
  );
}
