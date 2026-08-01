import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildCpaPackage, RETURN_BASES } from '../lib/cpaPackage';
import { downloadCpaPackageXlsx } from '../lib/cpaExcel';
import { money } from '../lib/format';
import { useModalA11y } from './modalA11y';

// The package you hand your accountant — one workbook per entity per year.
//
// ⚠ It shows a PRE-FLIGHT before it will download anything, and that is the point. A tax
// package that quietly files uncategorized money as "Other", or quietly drops every
// expense a cash basis cannot date, is worse than no package: it looks finished. So the
// figures that want an answer are stated here, on the way out, while they can still be
// fixed. Nothing is blocked — an honest package with a gap named beats a tidy one that
// hides it.
//
// No AI, no charge. Every figure is read from what the app already shows.
export default function ExportCpaModal({ corporationId, corporationName, year, onClose }) {
  const modalRef = useModalA11y(onClose);
  const [basis, setBasis] = useState('accrual');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: pkg, isLoading, isError } = useQuery({
    queryKey: ['cpaPackage', corporationId, year, basis],
    queryFn: () => buildCpaPackage({ corporationId, year, basis }),
  });

  async function download() {
    setErr(''); setBusy(true);
    try {
      await downloadCpaPackageXlsx({ corporationId, year, basis, prebuilt: pkg });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not build the workbook — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const s = pkg?.summary;
  const flags = [];
  if (s?.uncategorized) {
    flags.push({
      key: 'uncategorized',
      text: `${money(s.uncategorized.total)} has no tax category yet — it gets its own row rather than being filed as “Other”.`,
      fix: s.uncategorized.buckets.length ? `Buckets: ${s.uncategorized.buckets.join(' · ')}` : null,
    });
  }
  if ((s?.undated || 0) > 0.005) {
    flags.push({
      key: 'undated',
      text: `${money(s.undated)} of expenses carry no payment date, so a cash basis can’t place them in ${year}. They’re listed in full, never given an invented date — and they are not in the totals.`,
      fix: 'Switch to Accrual to include them, or add the dates on the Expense entry.',
    });
  }
  const assetCount = (pkg?.properties || []).reduce((n, p) => n + p.depreciation.count, 0);
  if (pkg && assetCount === 0) {
    flags.push({ key: 'assets', text: 'No assets are recorded, so depreciation is $0 on this return.', fix: 'Record the building under “What you own” to change that.' });
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Tax package · {corporationName || 'entity'} · {year}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Five sheets for your accountant: your income and expenses by tax category with one column per
            property, every line behind them, the depreciation schedule, what’s deliberately left off, and a
            tie-out against what Amlak shows on screen. Named for both <strong>Form 8825</strong> and{' '}
            <strong>Schedule E</strong>, since the form is your accountant’s call.
          </p>

          <div className="fin-subhead" style={{ marginTop: 4 }}>Basis</div>
          <div className="seg" role="group" aria-label="Reporting basis">
            {RETURN_BASES.map((b) => (
              <button
                key={b.key}
                type="button"
                className={`seg-btn${basis === b.key ? ' on' : ''}`}
                aria-pressed={basis === b.key}
                onClick={() => setBasis(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {RETURN_BASES.find((b) => b.key === basis)?.hint}
          </div>

          {isLoading && <p className="muted" style={{ marginTop: 14 }}>Reading your figures…</p>}
          {isError && <p className="note-msg danger" style={{ marginTop: 14 }}>Could not read the figures for {year}.</p>}

          {pkg && (
            <>
              <div className="fin-subhead" style={{ marginTop: 16 }}>What’s in it</div>
              <div className="cpa-pre">
                <div><span className="muted">Properties</span><b>{pkg.properties.length}</b></div>
                <div><span className="muted">Income</span><b className="pos">{money(s.income.total)}</b></div>
                <div><span className="muted">Expenses</span><b className="neg">{money(s.expenseTotal)}</b></div>
                <div><span className="muted">Net</span><b>{money(s.netIncome)}</b></div>
              </div>

              {pkg.excluded.groups.length > 0 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  {money(pkg.excluded.total)} of draws, contributions, deposits held and unplaced lines is
                  deliberately left off — listed on its own sheet with the reason, so nothing looks missed.
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
