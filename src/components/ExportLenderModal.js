import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildLenderPackage, coverage, lenderFlags, LENDER_ADJUSTMENTS } from '../lib/lenderPackage';
import { downloadLenderPackageXlsx } from '../lib/lenderExcel';
import { money, money0 } from '../lib/format';
import { useModalA11y } from './modalA11y';

// The package you hand a lender — one workbook per entity per year.
//
// ⚠ THE COVERAGE RATIO IS SHOWN ON SCREEN, BEFORE ANYTHING DOWNLOADS, BECAUSE THE
// DOWNSIDE IS THE CONVERSATION. Every accounting package computes DSCR backwards: last
// year's NOI over last year's debt service. Amlak holds the leases, so it can also say
// what the ratio becomes if the tenants reaching the end of their term walk — which is
// the number the landlord needs before they call the bank, not after.
//
// ⚠ AND THE THREE INPUTS ARE THE LENDER'S ASSUMPTIONS, NOT AMLAK'S FACTS. Debt service
// is one figure off a mortgage statement; the management fee and reserve are what a
// lender deducts whether or not you pay them. None of them is stored: Slice 6 will hold
// the real loan, and a remembered guess in the meantime would be a second source of
// truth for it. Leave them blank and the package still ships — the ratio reads "—".
//
// No AI, no charge. Every figure is read from what the app already shows.
export default function ExportLenderModal({ corporationId, corporationName, year, onClose }) {
  const modalRef = useModalA11y(onClose);
  const [debtService, setDebtService] = useState('');
  const [mgmtPct, setMgmtPct] = useState('');
  const [reservePsf, setReservePsf] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: pkg, isLoading, isError } = useQuery({
    queryKey: ['lenderPackage', corporationId, year],
    queryFn: () => buildLenderPackage({ corporationId, year }),
  });

  const assumptions = useMemo(() => ({
    debtService: Number(debtService) || null,
    mgmtPct: Number(mgmtPct) || null,
    reservePsf: Number(reservePsf) || null,
  }), [debtService, mgmtPct, reservePsf]);

  const cov = useMemo(() => (pkg ? coverage({
    egi: pkg.portfolio.egi,
    opex: pkg.portfolio.opex,
    atRisk: pkg.atRisk.total,
    buildingSf: pkg.portfolio.buildingSf,
    ...assumptions,
  }) : null), [pkg, assumptions]);

  const flags = pkg ? lenderFlags(pkg, cov) : [];

  async function download() {
    setErr(''); setBusy(true);
    try {
      await downloadLenderPackageXlsx({ corporationId, year, assumptions, prebuilt: pkg });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not build the workbook — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const risk = pkg?.atRisk;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 660 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Lender package · {corporationName || 'entity'} · {year}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Five sheets a lender reads in order: the operating summary, the statement behind it,
            the rent roll, when that rent rolls off — and what this package deliberately leaves out.
          </p>

          <div className="fin-subhead" style={{ marginTop: 4 }}>The lender’s assumptions</div>
          <div className="lender-inputs">
            <label>
              <span>Annual debt service</span>
              <input className="text-input" type="number" min="0" step="100" inputMode="decimal"
                placeholder="principal + interest" value={debtService} onChange={(e) => setDebtService(e.target.value)} />
            </label>
            <label>
              <span>Management fee</span>
              <input className="text-input" type="number" min="0" step="0.5" inputMode="decimal"
                placeholder={`${LENDER_ADJUSTMENTS.mgmtPct.low}–${LENDER_ADJUSTMENTS.mgmtPct.high} %`}
                value={mgmtPct} onChange={(e) => setMgmtPct(e.target.value)} />
            </label>
            <label>
              <span>Replacement reserve</span>
              <input className="text-input" type="number" min="0" step="0.05" inputMode="decimal"
                placeholder={`${LENDER_ADJUSTMENTS.reservePsf.low}–${LENDER_ADJUSTMENTS.reservePsf.high} $/SF`}
                value={reservePsf} onChange={(e) => setReservePsf(e.target.value)} />
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Amlak doesn’t hold your loans yet, so these are typed here and <strong>not saved</strong> — they’re the
            lender’s assumptions, not Amlak’s figures.
          </div>

          {isLoading && <p className="muted" style={{ marginTop: 14 }}>Reading your figures…</p>}
          {isError && <p className="note-msg danger" style={{ marginTop: 14 }}>Could not read the figures for {year}.</p>}

          {pkg && cov && (
            <>
              <div className="fin-subhead" style={{ marginTop: 16 }}>What a lender sees</div>
              <div className="cpa-pre">
                <div><span className="muted">Gross income</span><b className="pos">{money(pkg.portfolio.egi)}</b></div>
                <div><span className="muted">Expenses</span><b className="neg">{money(pkg.portfolio.opex)}</b></div>
                <div><span className="muted">NOI</span><b>{money(cov.now.noi)}</b></div>
                <div><span className="muted">Coverage</span><b>{cov.now.dscr == null ? '—' : `${cov.now.dscr.toFixed(2)}×`}</b></div>
              </div>

              {/* The forward read — the thing no accounting package can say, because none
                  of them hold the leases. */}
              {risk.total > 0.005 && (
                <div className="lender-forward">
                  <strong>
                    {cov.now.dscr == null
                      ? `${money0(risk.total)} of income is up for renewal within twelve months.`
                      : `Coverage falls to ${cov.down.dscr.toFixed(2)}× if that rollover doesn’t renew.`}
                  </strong>
                  <div className="muted">
                    {risk.leases.map((r) => r.tenant).join(' · ')} — {money(risk.total)} of rent and
                    reimbursement{risk.withOption > 0 ? `, ${risk.withOption} with an unexercised option` : ''}
                    {risk.nextNotice ? `, next notice deadline ${new Date(`${risk.nextNotice}T12:00:00`).toLocaleDateString('en-US')}` : ''}.
                    The expense stays either way, so their share becomes vacancy you carry.
                  </div>
                </div>
              )}

              {pkg.portfolio.noiGap != null && Math.abs(pkg.portfolio.noiGap) > 0.005 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  Amlak’s Financials page shows NOI of {money(pkg.portfolio.appNoi)} — {money(Math.abs(pkg.portfolio.noiGap))}{' '}
                  {pkg.portfolio.noiGap > 0 ? 'lower' : 'higher'} than the figure above, because that view takes the whole
                  expense out without counting the reimbursement it was paid back with. The workbook reconciles the two.
                </p>
              )}

              {flags.length > 0 && (
                <div className="cpa-flags">
                  {flags.map((f) => (
                    <div key={f.key} className="cpa-flag">
                      <span>{f.text}</span>
                      {f.fix && <span className="muted"> {f.fix}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {err && <p className="note-msg danger" style={{ marginTop: 10 }}>{err}</p>}
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button onClick={download} disabled={busy || isLoading || !pkg || !pkg.properties.length}>
              {busy ? 'Building…' : '⬇ Download Excel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
