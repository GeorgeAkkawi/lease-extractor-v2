import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import AnswerText from './AnswerText';

// Reusable "cached document + AI assistant": open the saved copy and ask
// questions about it. Decoupled from any one document type via callbacks:
//   ask(question) -> Promise<answer>     (required; wires the backend)
//   onSave(text)  -> Promise              (optional; only when canSave)
//   docText, suggested[], canSave, label ("lease" | "policy" | "contract" | …)
//   savedCopies   -> optional nodes rendered ABOVE this document's own row (the lease
//                    page puts its LEASE block here)
//   documents     -> optional nodes rendered BELOW it, before the ask box (the lease
//                    page puts its RIDERS block here)
//   hideOwnRow    -> the caller renders the document's row AND its text box itself, so
//                    this component contributes only the paste box and the ask box.
//
// The lease page passes hideOwnRow: its document is a LeaseDocs row shaped exactly like a
// rider's (George, 2026-08-04: "follow the same format as the riders"), which owns its own
// open/closed state. The insurance-policy and service-contract assistants keep the row
// below — one document, no riders, nothing to line it up with. The ask box stays the last
// thing on the panel either way; it was once stranded above a file list.
export default function DocAssistant({ docText, suggested = [], canSave = false, onSave, ask, label = 'document', documents = null, savedCopies = null, hideOwnRow = false }) {
  const [openDoc, setOpenDoc] = useState(false);
  const [q, setQ] = useState('');
  // Only the CURRENT question is shown — asking a new one replaces the previous Q&A
  // (George: "questions should just disappear after another one is asked"). Kept as a
  // one-element array so the render/onSuccess logic stays unchanged.
  const [log, setLog] = useState([]); // [{ q, a, pending }] — at most one entry
  const [draftText, setDraftText] = useState('');

  const hasDoc = !!(docText && docText.trim());

  const askM = useMutation({
    mutationFn: (question) => ask(question),
    onMutate: (question) => setLog([{ q: question, a: null, pending: true }]),
    onSuccess: (answer) =>
      setLog((l) => l.map((it, i) => (i === l.length - 1 ? { ...it, a: answer, pending: false } : it))),
    onError: (err) =>
      setLog((l) => l.map((it, i) => (i === l.length - 1 ? { ...it, a: `Sorry — ${err.message || 'something went wrong'}.`, pending: false } : it))),
  });

  const saveM = useMutation({
    mutationFn: (text) => onSave(text),
    onSuccess: () => setDraftText(''),
  });

  function submit(e) {
    e.preventDefault();
    const question = q.trim();
    if (!question || askM.isPending) return;
    setQ('');
    askM.mutate(question);
  }

  return (
    // .doc-panel carries the one variable that lines every "Open …" in this panel up
    // with this one — the lease, its saved copies, and each rider all end their primary
    // action at the same x (George, 2026-07-30: "the open lease button should be in line
    // with the lease open button"). See .doc-actions in App.css.
    <div className="doc-panel">
      {savedCopies}

      {/* This document's own row: what's on file, and the button that opens it. Skipped
          entirely when the caller supplies the row (hideOwnRow) — the lease's lives in
          LeaseDocs so it can carry the same shape as its riders. .doc-open-row in App.css
          takes a rule only when something precedes it. */}
      {!hideOwnRow && (
        <div className="between doc-open-row" style={{ marginBottom: 12 }}>
          {/* State only. "Ask anything about it below" used to live here too, repeating
              what the panel heading and its intro paragraph already said — three
              sentences for one idea. The ask box says what it is; this says what's on
              file. */}
          <span className="muted" style={{ fontSize: 12.5 }}>
            {hasDoc
              ? `A copy of this ${label} is saved.`
              : canSave
                ? `No ${label} saved yet. Paste it once and the assistant can answer questions about it.`
                : `No ${label} on file.`}
          </span>
          {hasDoc && (
            <span className="doc-actions">
              {/* "Read text", not "Open policy" — and btn-sm like every other action on
                  the panel. George, 2026-08-04: the buttons *"look different"*, and they
                  did: this one was the only full-size ghost, so it rendered UPPERCASE at
                  11.5px beside sentence-case 11px rows. The label change is the same fix
                  from the other side — "Open …" read as the same act whether it gave you
                  a transcription or a PDF. */}
              <button type="button" className="ghost btn-sm" onClick={() => setOpenDoc((o) => !o)}>
                {openDoc ? 'Hide text' : 'Read text'}
              </button>
              {/* The trailing column every row below reserves for its second control
                  (a copy's ✕, a rider's Open file). Empty here, so this button ends
                  exactly where theirs do. */}
              <span className="doc-act2" />
            </span>
          )}
        </div>
      )}

      {!hideOwnRow && hasDoc && openDoc && <div className="lease-doc">{docText}</div>}

      {/* The paste box belongs with the document's row above it — that status line is its
          cue ("No lease saved yet. Paste it once…") — so it stays there rather than being
          pushed below the riders. */}
      {!hasDoc && canSave && (
        <div style={{ marginBottom: 16 }}>
          {/* When the caller owns the row, the sentence that used to introduce this box
              went with it — so say it here instead of leaving a bare textarea. */}
          {hideOwnRow && (
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              No {label} text saved yet. Paste it once and the assistant can answer questions about it.
            </p>
          )}
          <textarea
            className="text-input"
            rows={5}
            style={{ width: '100%' }}
            placeholder={`Paste the ${label} text here to save a reference copy the assistant can read…`}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => saveM.mutate(draftText.trim())} disabled={!draftText.trim() || saveM.isPending}>
              {saveM.isPending ? 'Saving…' : `Save ${label} copy`}
            </button>
          </div>
        </div>
      )}

      {documents}

      {/* Ruled off from the documents above it, so the panel reads as two things —
          what you can open, then what you can ask — instead of one undifferentiated
          stack where the ask box looked like the last row of the file list. */}
      {(hasDoc || canSave) && (
        <div className="qa-ask">
          {log.length > 0 && (
            <div className="qa-log">
              {log.map((it, i) => (
                <div className="qa-item" key={i}>
                  <div className="qa-q">{it.q}</div>
                  {/* The answer comes back as markdown. AnswerText renders it as
                      headings, bullets and quoted clauses instead of printing the
                      asterisks and hyphens as punctuation. */}
                  {it.pending
                    ? <div className="qa-a thinking">Reading the {label}…</div>
                    : <AnswerText className="qa-a" text={it.a} />}
                </div>
              ))}
            </div>
          )}

          {log.length === 0 && suggested.length > 0 && (
            <div className="qa-chips">
              <span className="qa-chips-label">Try asking</span>
              {suggested.map((s) => (
                <button type="button" key={s} className="ghost btn-sm qa-chip" onClick={() => { if (!askM.isPending) askM.mutate(s); }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className="qa-form" onSubmit={submit}>
            <input className="text-input" placeholder={`Ask a question about this ${label}…`} value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" disabled={askM.isPending || !q.trim()}>{askM.isPending ? 'Asking…' : 'Ask'}</button>
          </form>
        </div>
      )}
    </div>
  );
}
