import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchPortfolioSnapshot, askPortfolioQuestion } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import { SparkIcon } from '../components/icons';

// "Ask Amlak" — a natural-language assistant over the account's OWN records
// (tenants, insurance, service contracts, rent, dates, balances). It reads a
// compact facts-only summary (no documents), so a question is sub-cent and
// repeats are free. Answers link straight to the tenant/property mentioned.
const SUGGESTED = [
  'Which tenants have no insurance on file?',
  'Whose insurance expires this year?',
  'Which properties have service contracts?',
  'Who owes money?',
  'Which leases end next year?',
];

export default function AskPage() {
  usePageChrome([{ label: 'Ask Amlak' }]);
  const [q, setQ] = useState('');
  const [log, setLog] = useState([]); // newest first: [{ q, answer, fromCache, pending, error }]

  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['portfolioSnapshot'],
    queryFn: fetchPortfolioSnapshot,
  });

  const askM = useMutation({
    mutationFn: (question) => askPortfolioQuestion(question, snapshot),
    onMutate: (question) => setLog((l) => [{ q: question, pending: true }, ...l]),
    onSuccess: (res) => setLog((l) => l.map((it, i) => (i === 0 ? { ...it, ...res, pending: false } : it))),
    onError: (err) => setLog((l) => l.map((it, i) => (i === 0 ? { ...it, error: err?.message || 'Something went wrong — please try again.', pending: false } : it))),
  });

  function ask(question) {
    const text = String(question || '').trim();
    if (!text || askM.isPending || !snapshot) return;
    setQ('');
    askM.mutate(text);
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
            It reads a summary of your records (never your documents) and links you straight to what it finds.
          </div>
        </div>
      </div>

      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input
          className="text-input ask-input"
          type="search"
          placeholder="e.g. Which tenants have no insurance on file?"
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
        {SUGGESTED.map((s) => (
          <button key={s} type="button" className="ask-chip" onClick={() => ask(s)} disabled={disabled}>
            {s}
          </button>
        ))}
      </div>

      {isLoading && <p className="muted" style={{ marginTop: 16 }}>Loading your portfolio…</p>}

      <div className="ask-log">
        {log.map((it, i) => (
          <div key={i} className="ask-entry">
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
