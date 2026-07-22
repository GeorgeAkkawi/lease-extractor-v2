import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

// Reusable "cached document + AI assistant": open the saved copy and ask
// questions about it. Decoupled from any one document type via callbacks:
//   ask(question) -> Promise<answer>     (required; wires the backend)
//   onSave(text)  -> Promise              (optional; only when canSave)
//   docText, suggested[], canSave, label ("lease" | "policy" | "contract" | …)
export default function DocAssistant({ docText, suggested = [], canSave = false, onSave, ask, label = 'document' }) {
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
    <div>
      <div className="between" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {hasDoc
            ? `A copy of this ${label} is saved — ask anything about it below.`
            : canSave
              ? `No ${label} saved yet. Paste it once and the assistant can answer questions about it.`
              : `No ${label} on file.`}
        </span>
        {hasDoc && (
          <button type="button" className="ghost" onClick={() => setOpenDoc((o) => !o)}>
            {openDoc ? `Hide ${label}` : `Open ${label}`}
          </button>
        )}
      </div>

      {hasDoc && openDoc && <div className="lease-doc">{docText}</div>}

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

      {(hasDoc || canSave) && (
        <>
          {log.length > 0 && (
            <div className="qa-log">
              {log.map((it, i) => (
                <div className="qa-item" key={i}>
                  <div className="qa-q">{it.q}</div>
                  <div className={`qa-a${it.pending ? ' thinking' : ''}`}>{it.pending ? `Reading the ${label}…` : it.a}</div>
                </div>
              ))}
            </div>
          )}

          {log.length === 0 && suggested.length > 0 && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {suggested.map((s) => (
                <button type="button" key={s} className="ghost" style={{ fontSize: 11 }} onClick={() => { if (!askM.isPending) askM.mutate(s); }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className="qa-form" onSubmit={submit}>
            <input className="text-input" placeholder={`Ask a question about this ${label}…`} value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" disabled={askM.isPending || !q.trim()}>{askM.isPending ? 'Asking…' : 'Ask'}</button>
          </form>
        </>
      )}
    </div>
  );
}
