import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reviewLease } from '../lib/api';
import { computeLeaseRisks } from '../lib/leaseRisks';
import { fmtDate } from '../lib/format';

// "Lease review" — the one place both halves of the red-flag read are shown.
//
// Two sources, one list, deliberately: the landlord doesn't care whether a concern came
// from the AI reading the document ("no personal guarantee") or from the app reading the
// record ("that certificate expired"). Both arrive in the same shape, sort together by
// severity, and read the same way.
//
// The AI half is SAVED (leases.ai_review) so it costs nothing to look at again; the code
// half is recomputed on every render, so it disappears the moment the underlying thing is
// fixed. That difference is why the saved half carries a date and a "re-review" button and
// the computed half doesn't need either.
const TONE = { high: 'danger', medium: 'warn', info: 'info' };
const RANK = { high: 0, medium: 1, info: 2 };
// See the `stale` note below — this covers the review's own save (and, on an import, the
// schedule work that follows it), so only a genuinely later edit reads as stale.
const STALE_GRACE_MS = 5 * 60 * 1000;

export default function LeaseReviewStrip({ lease, escalations, renewals, insurance, onJump }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);

  // The just-run result, held locally so the new flags appear the instant the read
  // returns rather than after the parent's lease query round-trips. The invalidation
  // below keeps the page's own copy in step; this is only about not showing the old
  // list for a beat after the landlord asked for a new one.
  const [justRun, setJustRun] = useState(null);
  const review = justRun || lease?.ai_review || null;
  const aiFlags = Array.isArray(review?.flags) ? review.flags : [];
  const codeFlags = computeLeaseRisks({ lease, escalations, renewals, insurance });
  const flags = [...aiFlags.map((f) => ({ ...f, source: 'ai' })), ...codeFlags]
    .sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

  const run = useMutation({
    mutationFn: () => reviewLease(lease.id),
    onSuccess: (rec) => { setJustRun(rec); qc.invalidateQueries({ queryKey: ['lease', lease.id] }); },
  });

  const hasText = !!lease?.lease_text;
  const highs = flags.filter((f) => f.severity === 'high').length;
  // The lease has changed since the AI read it — a rider may have fixed (or introduced)
  // something. Say so rather than presenting a stale read as current.
  //
  // The grace window is load-bearing, not a fudge: STORING a review is itself a write to
  // the lease row, so updated_at always lands a moment after reviewed_at, and a naive
  // comparison would declare every review stale the instant it was saved. An import does
  // the same — the review is written with the lease and backfillLeaseToToday updates the
  // row seconds later. A few minutes of slack separates "the write that saved this review"
  // from "somebody edited this lease afterwards", which is the only thing worth reporting.
  const stale = review?.reviewed_at && lease?.updated_at && !justRun
    && (new Date(lease.updated_at) - new Date(review.reviewed_at)) > STALE_GRACE_MS;

  return (
    <div className="panel lease-review">
      <div className="panel-head">
        <strong>Lease review</strong>
        <div className="review-head-actions">
          {flags.length > 0 && (
            <span className={`badge ${highs ? 'danger' : 'warn'}`}>
              {flags.length} {flags.length === 1 ? 'point' : 'points'} to look at
            </span>
          )}
          <button
            className="secondary"
            disabled={run.isPending || !hasText}
            title={hasText ? 'Reads this lease and its riders for missing protections' : 'No lease text on file to review'}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Reading…' : review ? '⚠ Re-review' : '⚠ Review this lease'}
          </button>
        </div>
      </div>

      {!hasText && (
        <p className="muted review-note">
          There’s no lease document on file for this tenant, so the AI has nothing to read. Upload or paste
          the lease and the review becomes available. The checks below still run — they read your records,
          not the document.
        </p>
      )}
      {run.isError && <div className="note-msg danger">{run.error?.message || 'The review couldn’t be completed — please try again.'}</div>}
      {stale && (
        <p className="muted review-note">
          This lease has changed since the AI last read it{review?.reviewed_at ? ` on ${fmtDate(String(review.reviewed_at).slice(0, 10))}` : ''}.
          Re-review to take the latest riders into account.
        </p>
      )}

      {flags.length === 0 ? (
        <p className="empty-line muted">
          {review || codeFlags.length === 0
            ? 'Nothing flagged. The records are complete and the AI found no missing protections it could name.'
            : 'Nothing flagged from your records yet. Run the review to have the lease itself read.'}
        </p>
      ) : (
        <>
          <div className="review-list">
            {(open ? flags : flags.slice(0, 3)).map((f) => (
              <div key={`${f.source}-${f.key}`} className={`review-item ${f.severity}`}>
                <div className="review-item-head">
                  <span className={`badge ${TONE[f.severity] || 'info'}`}>{f.severity === 'high' ? 'Look at this' : f.severity === 'medium' ? 'Worth checking' : 'For your information'}</span>
                  <strong>{f.title}</strong>
                </div>
                <div className="muted review-item-note">{f.note}</div>
                {f.quote && (
                  <details className="review-quote">
                    <summary>What the lease says</summary>
                    <blockquote>{f.quote}</blockquote>
                  </details>
                )}
                {f.panel && onJump && (
                  <button type="button" className="ghost review-jump" onClick={() => onJump(f.panel)}>
                    Go to {PANEL_LABEL[f.panel] || 'the relevant section'} →
                  </button>
                )}
              </div>
            ))}
          </div>
          {flags.length > 3 && (
            <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
              {open ? 'Show fewer' : `Show all ${flags.length}`}
            </button>
          )}
        </>
      )}

      <p className="muted review-foot">
        A reading aid, not legal advice — it points at what the lease does and doesn’t say so you know what to
        ask about. Check anything that matters with your attorney.
      </p>
    </div>
  );
}

const PANEL_LABEL = {
  terms: 'lease terms',
  renewals: 'renewal options',
  escalations: 'rent escalations',
  insurance: 'insurance',
  financials: 'the property’s financials',
};
