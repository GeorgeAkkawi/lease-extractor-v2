import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { build1099Worksheet, FILING_DEADLINE, EFILE_AT, PAYEE_SOURCES } from '../lib/form1099';
import { download1099WorksheetXlsx } from '../lib/form1099Excel';
import { money } from '../lib/format';
import { useModalA11y } from './modalA11y';

// The 1099 worksheet — the LIST and the QUESTION, never the filing.
//
// ⚠ It shows the candidates on screen rather than only in a download, because the action
// this produces is "go and collect a W-9", and it is due by January 31 — earlier than the
// return. A list you have to open a spreadsheet to read is a list you read in March.
//
// ⚠ AND IT ASKS RATHER THAN ASSERTS. A corporation is exempt and only a W-9 says whether
// a vendor is one, so the W-9 column is deliberately blank in the download and the
// question is stated here. Nothing is stored — the answer is not Amlak's to hold.
export default function Export1099Modal({ corporationId, corporationName, year, onClose }) {
  const modalRef = useModalA11y(onClose);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: pkg, isLoading, isError } = useQuery({
    queryKey: ['worksheet1099', corporationId, year],
    queryFn: () => build1099Worksheet({ corporationId, year }),
  });

  async function download() {
    setErr(''); setBusy(true);
    try {
      await download1099WorksheetXlsx({ corporationId, year, prebuilt: pkg });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not build the worksheet — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const c = pkg?.counts;
  const flags = [];
  if (c?.efile) {
    flags.push({
      key: 'efile',
      text: `${c.candidates} candidates is ${EFILE_AT} or more — at that point the IRS requires electronic filing.`,
      fix: 'Your accountant or a filing service handles that; Amlak does not file.',
    });
  }
  if (c?.imprecise) {
    flags.push({
      key: 'imprecise',
      text: `${c.imprecise} of these are named after an expense bucket, not a payee — one bucket can cover more than one vendor.`,
      fix: 'Confirm who each actually went to. Importing a bank statement teaches Amlak the payee.',
    });
  }
  if (c?.needsCategory) {
    flags.push({
      key: 'category',
      text: `${c.needsCategory} carry no tax category, so Amlak couldn’t rule them out and listed them rather than risk dropping one.`,
      fix: 'Set the category on the Expense entry to clear the ones that are utilities, materials or taxes.',
    });
  }
  if (c?.noMethod) {
    flags.push({
      key: 'method',
      text: `${c.noMethod} have no record of how they were paid — a card or payment-app charge is reported by the processor on a 1099-K and must not go on your 1099-NEC as well.`,
      fix: 'Check any of these you paid by card.',
    });
  }
  if (pkg && pkg.leftOff.unattributed > 0) {
    flags.push({
      key: 'flat',
      text: `${money(pkg.leftOff.unattributed)} of expenses is entered as a single yearly figure with no vendor attached, so it can’t be tested against the threshold at all.`,
      fix: 'Itemize it on the Expense entry, or check that money by hand.',
    });
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>1099 worksheet · {corporationName || 'entity'} · {year}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Vendors you may need to send a <strong>1099-NEC</strong> — due to the vendor and the
            IRS by <strong>{FILING_DEADLINE}</strong>. Amlak can’t tell whether a vendor is
            incorporated, and a corporation is generally exempt, so this names the candidates and
            asks: <strong>do you have a W-9 for each?</strong> It’s a worksheet, not a filing.
          </p>

          {isLoading && <p className="muted" style={{ marginTop: 14 }}>Reading your vendor payments…</p>}
          {isError && <p className="note-msg danger" style={{ marginTop: 14 }}>Could not read the figures for {year}.</p>}

          {pkg && (
            <>
              <div className="fin-subhead" style={{ marginTop: 16 }}>
                Above {money(pkg.threshold)} · {c.candidates} vendor{c.candidates === 1 ? '' : 's'}
              </div>

              {c.candidates === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  No vendor crossed the threshold on the figures recorded for {year}.
                  {c.below > 0 && ` ${c.below} smaller vendor${c.below === 1 ? ' is' : 's are'} still listed on the sheet.`}
                </p>
              ) : (
                <div className="w9-list">
                  {pkg.candidates.map((v) => (
                    <div key={v.key} className={`w9-row${v.report === 'always' ? ' always' : ''}`}>
                      <div className="w9-name">
                        <strong>{v.name}</strong>
                        <span className="muted">
                          {PAYEE_SOURCES[v.source]?.label || 'Unknown'}
                          {!v.precise && ' — not a payee'}
                          {v.categories.length ? ` · ${v.categories.join(' · ')}` : ''}
                        </span>
                      </div>
                      <div className="w9-amt">
                        <b>{money(v.reportable)}</b>
                        {v.cardTotal > 0 && <span className="muted">{money(v.cardTotal)} by card, excluded</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {pkg.candidates.some((v) => v.report === 'always') && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  A gold row is reported <strong>even if the vendor is incorporated</strong> — legal
                  fees don’t get the exemption every other corporation gets. It’s the most commonly
                  missed 1099 there is.
                </p>
              )}

              {c.below > 0 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {c.below} vendor{c.below === 1 ? '' : 's'} came in under the threshold and{' '}
                  {c.below === 1 ? 'is' : 'are'} still listed on the sheet — the threshold changed
                  between 2025 and 2026, so nothing is hidden behind that figure.
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
            <button onClick={download} disabled={busy || isLoading || !pkg}>
              {busy ? 'Building…' : '⬇ Download Excel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
