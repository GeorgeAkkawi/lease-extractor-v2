import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchPortfolioSnapshot, askPortfolioQuestion, askLeasesDocs } from '../lib/api';
import { useFeatures } from '../lib/features';
import { usePageChrome } from '../context/ChromeContext';
import { SparkIcon } from '../components/icons';

// "Ask Amlak" — a natural-language assistant over the account's OWN records
// (tenants, insurance, service contracts, rent, roof responsibility, lease terms,
// dates, balances). It reads a compact facts-only summary (no documents), so a
// question is sub-cent and repeats are free. When a question needs something the
// summary doesn't carry (e.g. an obscure lease clause), it offers a "read my
// leases" fallback that reads the cached documents with a quick model (~a few
// cents; repeats free). Answers link straight to the tenant/property mentioned.
// Each suggestion carries the feature it depends on (if any) so a chip about a
// switched-off module isn't offered.
const SUGGESTED = [
  { text: 'Which tenants have no insurance on file?', feature: 'insurance' },
  { text: 'Which tenants pay for the roof?' },
  { text: 'Who owes money?' },
  { text: 'Which leases end next year?' },
  { text: 'Which properties have service contracts?', feature: 'contracts' },
];

export default function AskPage() {
  usePageChrome([{ label: 'Ask Amlak' }]);
  const [q, setQ] = useState('');
  // newest first. Each entry has a stable id so the docs fallback can update the
  // right one after later questions prepend to the list.
  const [log, setLog] = useState([]);
  const idRef = useRef(0);
  // The snapshot is gated to the enabled modules, so Ask Amlak never reads (or answers
  // about) a section the landlord turned off. Feature changes re-key the query → refetch.
  const { enabled, isOn } = useFeatures();

  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['portfolioSnapshot', enabled],
    queryFn: () => fetchPortfolioSnapshot(enabled),
  });

  const suggestions = SUGGESTED.filter((s) => !s.feature || isOn(s.feature));

  const askM = useMutation({
    mutationFn: (question) => askPortfolioQuestion(question, snapshot),
    onMutate: (question) => {
      const id = ++idRef.current;
      setLog((l) => [{ id, q: question, pending: true }, ...l]);
      return { id };
    },
    onSuccess: (res, _q, ctx) => setLog((l) => l.map((it) => (it.id === ctx.id ? { ...it, ...res, pending: false } : it))),
    onError: (err, _q, ctx) => setLog((l) => l.map((it) => (it.id === ctx.id ? { ...it, error: err?.message || 'Something went wrong — please try again.', pending: false } : it))),
  });

  function ask(question) {
    const text = String(question || '').trim();
    if (!text || askM.isPending || !snapshot) return;
    setQ('');
    askM.mutate(text);
  }

  // The "read my leases" fallback for one answer entry: reads the cached lease
  // DOCUMENTS (a few cents; repeats free) and appends the result to that entry.
  async function askDocs(entry) {
    if (entry.docsState === 'pending' || entry.docsState === 'done') return;
    setLog((l) => l.map((it) => (it.id === entry.id ? { ...it, docsState: 'pending', docsError: null } : it)));
    try {
      const res = await askLeasesDocs(entry.q);
      setLog((l) => l.map((it) => (it.id === entry.id ? { ...it, docsState: 'done', docsAnswer: res.answer, docsFromCache: res.fromCache } : it)));
    } catch (err) {
      setLog((l) => l.map((it) => (it.id === entry.id ? { ...it, docsState: 'error', docsError: err?.message || 'Something went wrong reading your leases — please try again.' } : it)));
    }
  }

  // Every tenant/property name → its page, for click-through from an answer.
  const places = [];
  for (const p of snapshot?.properties || []) {
    if (p.corpId) places.push({ name: p.property, to: `/leases/${p.corpId}/${p.propId}` });
    for (const t of p.tenants) {
      if (t.corpId) places.push({ name: t.tenant, to: `/leases/${t.corpId}/${t.propId}/${t.tenant_id}` });
    }
  }
  // The records actually named in an answer (longest names first so a property
  // isn't shadowed by a tenant substring), capped so the row stays tidy.
  function mentioned(answer) {
    const text = String(answer || '');
    const seen = new Set();
    const out = [];
    for (const pl of [...places].sort((a, b) => b.name.length - a.name.length)) {
      if (pl.name && text.includes(pl.name) && !seen.has(pl.to)) {
        seen.add(pl.to);
        out.push(pl);
      }
    }
    return out.slice(0, 12);
  }

  const disabled = askM.isPending || isLoading;

  return (
    <div className="ask-page">
      <div className="page-head">
        <div>
          <h1><SparkIcon /> Ask Amlak</h1>
          <div className="muted">
            Ask about your tenants, insurance, contracts, rent, or who owes money — in plain English.
            It reads a summary of your records and links you straight to what it finds; when a question
            needs the fine print, you can have it read your lease documents too.
          </div>
        </div>
      </div>

      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input
          className="text-input ask-input"
          type="search"
          placeholder="e.g. Which tenants pay for the roof?"
          aria-label="Ask a question about your portfolio"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" disabled={disabled || !q.trim()}>
          {askM.isPending ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      <div className="ask-chips">
        <span className="muted">Try:</span>
        {suggestions.map((s) => (
          <button key={s.text} type="button" className="ask-chip" onClick={() => ask(s.text)} disabled={disabled}>
            {s.text}
          </button>
        ))}
      </div>

      {isLoading && <p className="muted" style={{ marginTop: 16 }}>Loading your portfolio…</p>}

      {log.length > 0 && (
        <div className="ask-log-head">
          <button type="button" className="ghost" onClick={() => setLog([])}>Clear answers</button>
        </div>
      )}

      <div className="ask-log">
        {log.map((it) => (
          <div key={it.id} className="ask-entry">
            <div className="ask-q">{it.q}</div>
            {it.pending ? (
              <div className="ask-a muted">Reading your records…</div>
            ) : it.error ? (
              <div className="note-msg warn">{it.error}</div>
            ) : (
              <div className="ask-a">
                <div className="ask-a-head">
                  <strong>Answer</strong>
                  {it.fromCache && <span className="muted"> · saved answer (free)</span>}
                </div>
                <div className="ask-a-body">{it.answer}</div>
                {mentioned(it.answer).length > 0 && (
                  <div className="ask-jump">
                    <span className="muted">Open:</span>
                    {mentioned(it.answer).map((pl) => (
                      <Link key={pl.to} className="ask-chip" to={pl.to}>{pl.name}</Link>
                    ))}
                  </div>
                )}

                {/* "Read my leases" fallback — prominent when the summary couldn't
                    answer, a quiet option otherwise (in case the fact answer is wrong). */}
                {it.docsState === 'pending' ? (
                  <div className="ask-a muted" style={{ marginTop: 12 }}>Reading your lease documents…</div>
                ) : it.docsState === 'error' ? (
                  <div className="note-msg warn" style={{ marginTop: 12 }}>{it.docsError}</div>
                ) : it.docsState === 'done' ? (
                  <div className="ask-docs-answer">
                    <div className="ask-a-head">
                      <strong>From your lease documents</strong>
                      {it.docsFromCache && <span className="muted"> · saved answer (free)</span>}
                    </div>
                    <div className="ask-a-body">{it.docsAnswer}</div>
                    {mentioned(it.docsAnswer).length > 0 && (
                      <div className="ask-jump">
                        <span className="muted">Open:</span>
                        {mentioned(it.docsAnswer).map((pl) => (
                          <Link key={pl.to} className="ask-chip" to={pl.to}>{pl.name}</Link>
                        ))}
                      </div>
                    )}
                  </div>
                ) : it.needsDocs ? (
                  <button type="button" className="ask-docs-btn" onClick={() => askDocs(it)}>
                    📄 Read my leases to answer this <span className="muted">(~a few cents)</span>
                  </button>
                ) : (
                  <button type="button" className="ghost ask-docs-link" onClick={() => askDocs(it)}>
                    Answer from the lease documents instead
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {!isLoading && log.length === 0 && (
        <p className="muted ask-empty">Ask a question above, or tap one of the suggestions to get started.</p>
      )}
    </div>
  );
}
