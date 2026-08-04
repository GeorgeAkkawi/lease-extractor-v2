import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import AnswerText from './AnswerText';

// Reusable "cached document + AI assistant": open the saved copy and ask
// questions about it. Decoupled from any one document type via callbacks:
//   ask(question) -> Promise<answer>     (required; wires the backend)
//   onSave(text)  -> Promise              (optional; only when canSave)
//   docText, suggested[], canSave, label ("lease" | "policy" | "contract" | …)
//   savedCopies   -> optional nodes rendered ABOVE this document's own "Open …" row
//                    (the lease page puts its saved-copies list here)
//   documents     -> optional nodes rendered BELOW it, before the ask box (the lease
//                    page puts its riders here)
//
// The two slots are what put the panel in the order George asked for, 2026-08-04: "the
// order should go the saved copy of the lease, then open lease, then open riders" — so
// "Open lease" sits directly above "Open rider" again, which was his original placement
// (2026-07-30) before the copies list was added between them. The ask box stays the last
// thing on the panel either way; it was once stranded above a file list.
export default function DocAssistant({ docText, suggested = [], canSave = false, onSave, ask, label = 'document', documents = null, savedCopies = null }) {
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

      {/* This document's own row: what's on file, and the button that opens it. It sits
          BETWEEN the saved copies above and the riders below, and is ruled off like both
          of them — .doc-open-row in App.css, which skips the rule when nothing precedes
          it (the policy, contract and archived-lease assistants pass no savedCopies). */}
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
            <button type="button" className="ghost" onClick={() => setOpenDoc((o) => !o)}>
              {openDoc ? `Hide ${label}` : `Open ${label}`}
            </button>
            {/* The trailing column every row below reserves for its second control
                (a copy's ✕, a rider's Open file). Empty here, so this button ends
                exactly where theirs do. */}
            <span className="doc-act2" />
          </span>
        )}
      </div>

      {hasDoc && openDoc && <div className="lease-doc">{docText}</div>}

      {/* The paste box belongs to the row above it — that status line is its cue ("No
          lease saved yet. Paste it once…"), so it stays with it rather than being pushed
          below the riders now that the row has moved down. */}
      {!hasDoc && canSave && (
        <div style={{ marginBottom: 16 }}>
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
