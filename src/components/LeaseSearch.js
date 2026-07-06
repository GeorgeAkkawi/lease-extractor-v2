import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAddendumsByLeases, askLeasesQuestion, COMMON_QUESTION_TERMS } from '../lib/api';
import { searchLeases } from '../lib/leaseSearch';
import { fmtDate } from '../lib/format';

// Search every cached lease document at this property. The keyword scan is a pure
// in-browser match (no AI, no cost) and shows the surrounding clause. On top of it,
// an optional "Answer with AI" reads ONLY the matched clauses and answers the
// question across tenants — cheap (~½¢, and free once asked because answers are
// cached per property).
export default function LeaseSearch({ propId, query, onChange, leases = [], onOpen, onWarm }) {
  const active = query.trim().length > 0;
  const term = query.trim();

  // AI answer state (only used when the landlord clicks "Answer with AI").
  const [ai, setAi] = useState(null); // { term, answer, fromCache, empty } | null
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  // Rider texts load once per property, and only when a search actually starts,
  // so the page load stays as light as before.
  const { data: addendumsByLease = {} } = useQuery({
    queryKey: ['addendumsByLeases', propId],
    queryFn: () => listAddendumsByLeases(leases.map((l) => l.id)),
    enabled: active && leases.length > 0,
  });

  const { matches, unsearchable } = searchLeases(query, leases, addendumsByLease);

  // The AI answer is shown only while it still matches what's typed.
  const answerShown = ai && ai.term.toLowerCase() === term.toLowerCase();

  async function runAi(forTerm) {
    const t = String(forTerm || '').trim();
    if (!t) return;
    setAiError('');
    setAiLoading(true);
    try {
      const res = await askLeasesQuestion(propId, t, { leases, addendumsByLease });
      setAi({ term: t, ...res });
    } catch (e) {
      setAiError(e?.message || 'Could not get an answer. Please try again.');
    } finally {
      setAiLoading(false);
    }
  }

  function pickChip(t) {
    onChange(t);
    setAi(null);
    setAiError('');
    runAi(t);
  }

  return (
    <div className="lease-search">
      <input
        className="text-input lease-search-input"
        type="search"
        placeholder="Search all leases here — try roof, parking, insurance…"
        aria-label="Search leases"
        value={query}
        onChange={(e) => onChange(e.target.value)}
      />

      {leases.length > 0 && (
        <div className="lease-search-chips">
          <span className="muted">Common questions:</span>
          {COMMON_QUESTION_TERMS.map((t) => (
            <button key={t} type="button" className="chip" onClick={() => pickChip(t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="lease-list search-results">
          {matches.length > 0 && (
            <div className="ai-answer-bar">
              <button
                type="button"
                className="btn-sm"
                onClick={() => runAi(term)}
                disabled={aiLoading}
              >
                {aiLoading ? 'Reading the matched clauses…' : `🤖 Answer: who's responsible for “${term}”?`}
              </button>
              <span className="muted ai-answer-hint">
                Reads only the matched clauses — about ½¢, and free once asked.
              </span>
            </div>
          )}

          {aiError && <p className="note-msg warn">{aiError}</p>}

          {answerShown && (
            <div className="ai-answer">
              <div className="ai-answer-head">
                <strong>AI answer</strong>
                {ai.fromCache && <span className="muted"> · saved answer (free)</span>}
              </div>
              <div className="ai-answer-body">{ai.answer}</div>
              <p className="muted ai-answer-foot">
                Based on the highlighted clauses below — always confirm against the lease itself.
              </p>
            </div>
          )}

          {matches.map((m) => (
            <button
              key={m.lease.id}
              className="lease-row search-hit"
              onClick={() => onOpen(m.lease.id)}
              onMouseEnter={onWarm ? () => onWarm(m.lease.id) : undefined}
              onFocus={onWarm ? () => onWarm(m.lease.id) : undefined}
            >
              <span className="lease-name">
                <strong>{m.lease.tenant_name}</strong>
                <span className="muted">
                  {m.count} match{m.count === 1 ? '' : 'es'} · term ends{' '}
                  {m.lease.lease_termination_date ? fmtDate(m.lease.lease_termination_date) : '—'}
                </span>
              </span>
              <span className="hit-snippets">
                {m.snippets.map((s, i) => (
                  <span key={i} className="hit-snippet">
                    …{s.before}<mark>{s.hit}</mark>{s.after}…
                    {s.source ? <em> — {s.source}</em> : null}
                  </span>
                ))}
              </span>
              <span className="chevron">›</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="muted">No lease at this property mentions “{query.trim()}”.</p>
          )}
          {unsearchable.length > 0 && (
            <p className="muted search-note">
              {unsearchable.length === 1 ? '1 lease has' : `${unsearchable.length} leases have`} no
              document on file and can't be searched: {unsearchable.map((l) => l.tenant_name).join(', ')}.
              Open the lease and upload or paste its document to make it searchable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
