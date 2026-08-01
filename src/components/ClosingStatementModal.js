// Slice 5c — read a closing statement, and show what it does NOT become.
//
// Every other extractor's review screen answers "did it read the fields right". This one
// also has to answer "did it capitalize the right half", because a settlement statement
// is mostly charges that are not basis. So the screen has two lists: what becomes an
// asset, and what does not — each with where it actually belongs. The second list is
// what makes the first one trustworthy; without it, a landlord has no way to tell a
// careful read from one that quietly dropped thirty lines.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { extractClosingStatement, saveClosingStatement, uploadDoc, discardDocument } from '../lib/api';
import { proposedAssets, notCapitalized, readSummary } from '../lib/closingStatement';
import { assetKindInfo } from '../lib/depreciation';
import { money } from '../lib/format';
import { useModalA11y } from './modalA11y';

export default function ClosingStatementModal({ propId, propertyName, onClose }) {
  const qc = useQueryClient();
  const modalRef = useModalA11y(onClose);

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [read, setRead] = useState(null);       // the raw AI read
  const [docPath, setDocPath] = useState(null); // uploaded file, attached only on save
  const [rows, setRows] = useState([]);         // the editable proposed assets
  const [closing, setClosing] = useState('');

  async function intake(getExtract, path) {
    setBusy(true); setErr('');
    try {
      const { fields } = await getExtract();
      const assets = proposedAssets(fields, { propertyName });
      setRead(fields);
      setRows(assets.map((a) => ({ ...a, cost: String(a.cost ?? ''), land_cost: a.land_cost == null ? '' : String(a.land_cost) })));
      setClosing(fields.closing_date && /^\d{4}-\d{2}-\d{2}$/.test(fields.closing_date) ? fields.closing_date : '');
      if (path) setDocPath(path);
      setText(''); setPaste(false);
      if (!assets.length) setErr('Nothing on this document looked like a purchase price or a capitalizable cost — check it is the settlement statement.');
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  const onPaste = () => { if (text.trim()) intake(() => extractClosingStatement({ text: text.trim() })); };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) {
      setBusy(true); setErr('');
      try {
        // Registered against the property up front, so a read that is never confirmed
        // is still findable rather than a nameless object in the bucket.
        const path = await uploadDoc(f, { entityType: 'property', entityId: propId, label: 'Closing statement' });
        await intake(() => extractClosingStatement({ storagePath: path }), path);
      } catch (e2) { setErr(e2.message || String(e2)); setBusy(false); }
    }
    e.target.value = '';
  };

  // Cancelling after a read throws the upload away — file AND registry row. An explicit
  // cancel is the only thing that deletes it.
  async function cancel() {
    if (docPath && !saving) { try { await discardDocument(docPath); } catch { /* ignore */ } }
    onClose();
  }

  async function save() {
    setSaving(true); setErr('');
    try {
      const payload = rows
        .filter((r) => Number(r.cost) > 0)
        .map((r) => ({
          kind: r.kind,
          description: r.description,
          cost: Number(r.cost),
          land_cost: r.land_cost === '' ? null : Number(r.land_cost),
          placed_in_service: closing || null,
          useful_life_years: r.useful_life_years || null,
          note: r.note,
        }));
      await saveClosingStatement(propId, payload, { storagePath: docPath });
      qc.invalidateQueries({ queryKey: ['fixedAssets', propId] });
      qc.invalidateQueries({ queryKey: ['documents', 'property', propId] });
      onClose();
    } catch (e) { setErr(e.message || String(e)); setSaving(false); }
  }

  const left = read ? notCapitalized(read) : null;
  const sum = read ? readSummary(read) : null;
  const landStated = read?.land_value != null;
  const canSave = rows.some((r) => Number(r.cost) > 0) && !saving;

  return (
    <div className="modal-scrim" onClick={cancel}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{propertyName} — closing statement</strong>
          <button className="icon-btn" onClick={cancel}>✕</button>
        </div>

        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            The settlement statement from when you bought this property — an ALTA statement, a HUD-1,
            or a closing disclosure. Read <strong>once, ever</strong>: it is the only document that says
            what the building cost, which is what everything on this page depreciates from.
          </p>

          {!read && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <label className="secondary" style={{ cursor: 'pointer', margin: 0 }}>
                  {busy ? 'Reading…' : '⬆ Upload closing statement'}
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" style={{ display: 'none' }} onChange={onFile} disabled={busy} />
                </label>
                <button type="button" className="secondary" onClick={() => setPaste((p) => !p)} disabled={busy}>
                  {paste ? 'Cancel paste' : 'Paste text'}
                </button>
              </div>
              {paste && (
                <div style={{ marginBottom: 12 }}>
                  <textarea className="text-input" rows={6} style={{ width: '100%' }}
                    placeholder="Paste the settlement statement text here…"
                    value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                    <button type="button" onClick={onPaste} disabled={busy || !text.trim()}>Read it</button>
                  </div>
                </div>
              )}
            </>
          )}

          {read && (
            <>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>Closing date</span>
                <input className="text-input" type="date" style={{ maxWidth: 165, minWidth: 0 }}
                  value={closing} onChange={(e) => setClosing(e.target.value)} />
              </div>
              {!closing && (
                <div className="note-msg warn" style={{ marginBottom: 10 }}>
                  The closing date wasn’t on the document — nothing depreciates without it, so set it here.
                </div>
              )}

              <div className="fin-subhead" style={{ marginTop: 12 }}>What this becomes</div>
              {rows.map((r, i) => {
                const info = assetKindInfo(r.kind);
                return (
                  <div key={i} className="cs-asset">
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, flex: '1 1 190px', minWidth: 0 }}>{r.description}</strong>
                      <input className="text-input" style={{ maxWidth: 130 }} type="number" step="0.01"
                        value={r.cost}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />
                      {info.landSplit && (
                        <input className="text-input" style={{ maxWidth: 145 }} type="number" step="0.01"
                          placeholder="Of which, land"
                          value={r.land_cost}
                          onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, land_cost: e.target.value } : x)))} />
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {info.label}
                      {info.life ? ` · ${info.life} years` : ''}
                      {r.kind === 'loan_costs' && (
                        <> · <span className="cs-warn">no life yet — points amortize over your loan’s term, which Amlak doesn’t know</span></>
                      )}
                      {info.landSplit && !landStated && (
                        <> · <span className="cs-warn">the land value isn’t on this document — set it here or on the row afterwards</span></>
                      )}
                    </div>
                  </div>
                );
              })}

              {landStated && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                  Land read from the document: <strong>{money(read.land_value)}</strong>
                  {read.land_value_quote ? <> — “{read.land_value_quote}”</> : null}
                </div>
              )}

              {/* ⚠ THE LIST THAT MAKES THE ONE ABOVE TRUSTWORTHY. */}
              {!!left?.lineCount && (
                <>
                  <div className="fin-subhead" style={{ marginTop: 16 }}>
                    What it does <em>not</em> become — {left.lineCount} {left.lineCount === 1 ? 'charge' : 'charges'}, {money(left.total)}
                  </div>
                  {left.groups.map((g) => (
                    <div key={g.key} style={{ marginBottom: 8 }}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                        <strong style={{ fontSize: 12.5 }}>{g.label}</strong>
                        <span className="num" style={{ fontSize: 12.5 }}>{money(g.total)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>{g.why}</div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {g.lines.map((l) => `${l.label} ${money(l.amount)}`).join(' · ')}
                      </div>
                    </div>
                  ))}
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    None of these are recorded anywhere — reading a document isn’t a reason to move a
                    figure on a year you may have already closed. Enter any of them yourself if you want them.
                  </div>
                </>
              )}

              {!!sum && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
                  {sum.lineCount} {sum.lineCount === 1 ? 'charge' : 'charges'} read · {sum.placed} placed
                  {sum.unreadable ? ` · ${sum.unreadable} had no readable amount` : ''}
                </div>
              )}
            </>
          )}

          {err && <div className="note-msg danger" style={{ marginTop: 10 }}>{err}</div>}
        </div>

        <div className="modal-foot">
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={cancel}>Cancel</button>
            {read && (
              <button type="button" onClick={save} disabled={!canSave}>
                {saving ? 'Saving…' : `Record ${rows.filter((r) => Number(r.cost) > 0).length} ${rows.filter((r) => Number(r.cost) > 0).length === 1 ? 'asset' : 'assets'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
