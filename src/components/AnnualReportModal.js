import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAnnualReport, saveAnnualReport, markAnnualReportFiled,
  extractAnnualReport, uploadDoc, signDocUrl, localDateIso,
} from '../lib/api';
import { fmtDate } from '../lib/format';
import { useModalA11y } from './modalA11y';

// Per-corporation annual state filing. The landlord uploads (or pastes) the report;
// the AI reads only the date it must be filed each year; the app then reminds him a
// month ahead. "Mark filed" rolls the deadline forward a year. Every uploaded report
// stays on file (docs[]). No tenant-facing anything — this is the landlord's own filing.
export default function AnnualReportModal({ corp, onClose }) {
  const modalRef = useModalA11y(onClose);
  const qc = useQueryClient();
  const { data: rec, isLoading } = useQuery({
    queryKey: ['annualReport', corp.id],
    queryFn: () => getAnnualReport(corp.id),
  });

  const [dueDate, setDueDate] = useState('');
  const [pendingDoc, setPendingDoc] = useState(null); // path of a just-uploaded report, saved on Save
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [touched, setTouched] = useState(false);

  // The value shown in the date field: the landlord's in-progress edit if they've
  // touched it, otherwise whatever the AI filled, otherwise the saved date.
  const shownDue = touched ? dueDate : (dueDate || rec?.due_date || '');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['annualReport', corp.id] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
  };

  const save = useMutation({
    mutationFn: () => {
      const docs = [...(rec?.docs || [])];
      if (pendingDoc) docs.push({ path: pendingDoc, uploaded_at: localDateIso() });
      return saveAnnualReport(corp.id, { due_date: shownDue || null, docs });
    },
    onSuccess: () => { invalidate(); onClose(); },
  });

  const filed = useMutation({
    mutationFn: () => markAnnualReportFiled(corp.id),
    onSuccess: () => invalidate(),
  });

  // Upload / paste → AI reads the filing deadline → pre-fill the date field for review.
  async function intake(getExtract, docPath) {
    setBusy(true); setErr('');
    try {
      const { fields } = await getExtract();
      if (fields.due_date) { setDueDate(fields.due_date); setTouched(true); }
      if (docPath) setPendingDoc(docPath);
      setText(''); setPaste(false);
      if (!fields.due_date) setErr('The AI could not find a filing deadline — enter it by hand.');
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }
  const onPaste = () => { if (text.trim()) intake(() => extractAnnualReport({ text: text.trim() })); };
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) {
      setBusy(true); setErr('');
      try {
        const path = await uploadDoc(f);
        await intake(() => extractAnnualReport({ storagePath: path }), path);
      } catch (e2) { setErr(e2.message || String(e2)); setBusy(false); }
    }
    e.target.value = '';
  };

  async function open(path) {
    try { const url = await signDocUrl(path); if (url) window.open(url, '_blank', 'noopener'); }
    catch { /* ignore */ }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{corp.name} — annual report</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            The yearly state filing for this corporation. Upload the report (or paste its text) and
            the AI reads the date it must be filed — we'll remind you a month ahead, every year.
          </p>

          {isLoading ? <p className="muted">Loading…</p> : (
            <>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
                {rec?.due_date
                  ? <>Files every year by <strong>{fmtDate(rec.due_date)}</strong>{rec.last_filed_date ? <> · last filed {fmtDate(rec.last_filed_date)}</> : ''}</>
                  : 'No filing date on file yet.'}
              </div>

              {/* Upload / paste — AI reads the filing deadline */}
              <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <label className="secondary" style={{ cursor: 'pointer', margin: 0 }}>
                  {busy ? 'Reading…' : '⬆ Upload report'}
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" style={{ display: 'none' }} onChange={onFile} disabled={busy} />
                </label>
                <button type="button" className="secondary" onClick={() => setPaste((p) => !p)} disabled={busy}>
                  {paste ? 'Cancel paste' : 'Paste text'}
                </button>
              </div>
              {paste && (
                <div style={{ marginBottom: 12 }}>
                  <textarea className="text-input" rows={5} style={{ width: '100%' }} placeholder="Paste the annual-report text here…" value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                    <button type="button" onClick={onPaste} disabled={busy || !text.trim()}>Read it</button>
                  </div>
                </div>
              )}

              {/* The filing date — AI-filled or typed by hand */}
              <label className="form-field" style={{ maxWidth: '100%' }}>
                <span>Filing due date</span>
                <input
                  className="text-input" type="date"
                  value={shownDue || ''}
                  onChange={(e) => { setDueDate(e.target.value); setTouched(true); }}
                />
                <span className="hint">The date this report must be filed. We remind you 1 month before.</span>
              </label>

              {err && <p className="note-msg warn" style={{ marginTop: 4 }}>{err}</p>}

              {/* Reports on file */}
              {(rec?.docs?.length > 0) && (
                <div style={{ marginTop: 14 }}>
                  <div className="ins-k" style={{ marginBottom: 6 }}>Reports on file</div>
                  {rec.docs.map((d, i) => (
                    <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                      <span className="muted" style={{ fontSize: 12.5 }}>Uploaded {d.uploaded_at ? fmtDate(d.uploaded_at) : '—'}</span>
                      {d.path && <button type="button" className="ghost" onClick={() => open(d.path)}>Open</button>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            {rec?.due_date
              ? <button className="secondary" onClick={() => filed.mutate()} disabled={filed.isPending}>{filed.isPending ? 'Saving…' : '✓ Mark filed'}</button>
              : <span className="muted">{save.isError ? 'Could not save' : 'Reminds you 1 month ahead'}</span>}
            <div className="row">
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending || busy}>{save.isPending ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
