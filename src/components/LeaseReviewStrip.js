import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reviewLease, setLeaseReviewDismissedKeys, MIN_USABLE_TEXT } from '../lib/api';
import { computeLeaseRisks, transcriptGaps } from '../lib/leaseRisks';
import { fmtDate } from '../lib/format';
import { useConfirm } from './ConfirmDialog';
import MutationError from './MutationError';

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
  const askConfirm = useConfirm();
  const [open, setOpen] = useState(true);

  // The just-run result, held locally so the new flags appear the instant the read
  // returns rather than after the parent's lease query round-trips. The invalidation
  // below keeps the page's own copy in step; this is only about not showing the old
  // list for a beat after the landlord asked for a new one.
  const [justRun, setJustRun] = useState(null);
  const review = justRun || lease?.ai_review || null;
  // Dismissed = "I have read this", ONE FINDING AT A TIME. Nothing is deleted: the flag
  // stays on the lease and "Show all again" puts it back, because a review that can only be
  // cleared by re-running it is one the landlord learns to scroll past instead.
  // `dismissed_at` is the earlier whole-review stamp — read, never written, so a lease
  // dismissed before this shipped stays dismissed.
  const savedFlags = Array.isArray(review?.flags) ? review.flags : [];
  const dismissedKeys = review?.dismissed_at
    ? savedFlags.map((f) => f.key)
    : (Array.isArray(review?.dismissed_keys) ? review.dismissed_keys : []);
  const aiFlags = savedFlags.filter((f) => !dismissedKeys.includes(f.key));
  const dismissedCount = savedFlags.length - aiFlags.length;
  const codeFlags = computeLeaseRisks({ lease, escalations, renewals, insurance });
  const flags = [...aiFlags.map((f) => ({ ...f, source: 'ai' })), ...codeFlags]
    .sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

  const run = useMutation({
    mutationFn: () => reviewLease(lease.id),
    onSuccess: (rec) => {
      setJustRun(rec);
      qc.invalidateQueries({ queryKey: ['lease', lease.id] });
      // The property's tenant list wears a badge built from this review — without this it
      // keeps showing the previous count (or none) until something else refetches.
      qc.invalidateQueries({ queryKey: ['leaseReviews'] });
    },
  });

  // Reading it, and un-reading it. Both go through the same helper so `dismissed_at` only
  // ever lives inside the saved review object.
  const dismiss = useMutation({
    mutationFn: (keys) => setLeaseReviewDismissedKeys(lease.id, review, keys),
    onSuccess: (next) => {
      setJustRun(next);
      qc.invalidateQueries({ queryKey: ['lease', lease.id] });
      qc.invalidateQueries({ queryKey: ['leaseReviews'] });
    },
  });

  // Ask before running. This used to fire the instant the button was clicked — the only AI
  // action in the app with no confirmation, which made the quiet button the one with no
  // guard rail (George, 2026-08-05). Same dialog and the same facts as the property-wide
  // sweep, so the two read as one feature at two scales rather than two different things.
  // ⚠ It states no price: "take out how much it costs, the user doesn't care about that".
  const askThenRun = async () => {
    const again = !!review;
    const ok = await askConfirm({
      title: again ? 'Re-review this lease?' : 'Review this lease?',
      message: 'This lease is read for terms that commonly cost a landlord money — no personal guarantee, no late fee, an uncapped CAM, and seven more.',
      implications: [
        'Only this tenant’s lease is read — use “⚑ Review leases” on the property to do all of them at once.',
        'The result is saved, so re-opening this page shows it again without re-reading.',
        'Nothing is written to the lease’s terms — this only fills the red-flag panel below.',
        ...(again ? ['The findings currently shown are replaced by the new read.'] : []),
      ],
      confirmLabel: again ? 'Re-review lease' : 'Review lease',
      // A read, not a delete — see the same note on ReviewLeasesButton.
      tone: 'default',
    });
    if (ok) run.mutate();
  };

  const hasText = !!lease?.lease_text;
  // How much of the document the review could actually read. A finding that the lease is
  // SILENT on something is indistinguishable from a page that never transcribed, so a
  // partial read has to say so ABOVE the findings rather than let them stand unqualified.
  const gaps = transcriptGaps(lease?.lease_text);
  const barelyRead = gaps.readableLength < MIN_USABLE_TEXT;
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
          {/* Dismiss is offered only while there ARE saved findings on screen: nothing to
              read means nothing to mark read. It stamps the review rather than clearing it,
              so "Show again" is a free undo and the findings are never lost. */}
          {aiFlags.length > 0 && (
            <button
              className="secondary"
              disabled={dismiss.isPending}
              title="Mark every document finding read — they fold away here and the flag leaves this tenant on the property list"
              onClick={() => dismiss.mutate(savedFlags.map((f) => f.key))}
            >
              {dismiss.isPending ? 'Dismissing…' : '✓ Mark all read'}
            </button>
          )}
          <button
            className="secondary"
            disabled={run.isPending || !hasText}
            title={hasText ? 'Reads this lease and its riders for missing protections' : 'No lease text on file to review'}
            onClick={askThenRun}
          >
            {run.isPending ? 'Reading…' : review ? '⚠ Re-review' : '⚠ Review this lease'}
          </button>
        </div>
      </div>

      {/* The dismissed state. It says WHAT was folded away and offers it straight back —
          a dismissal that hid the count would just be a review the landlord can no longer
          find. The free record checks below are unaffected: they are recomputed live and
          disappear on their own when the underlying thing is fixed. */}
      {dismissedCount > 0 && (
        <p className="muted review-note">
          {dismissedCount} {dismissedCount === 1 ? 'finding' : 'findings'} from the document marked read.{' '}
          <button className="linkish" onClick={() => dismiss.mutate([])} disabled={dismiss.isPending}>
            Show {dismissedCount === 1 ? 'it' : 'them'} again
          </button>
        </p>
      )}

      {!hasText && (
        <p className="muted review-note">
          {lease?.lease_file_id
            ? 'A document is on file for this tenant, but no searchable text could be read from it — it may be a photo of a photo, or too faint to transcribe. Re-upload a clearer scan and the review becomes available.'
            : 'There’s no lease document on file for this tenant, so the AI has nothing to read. Upload or paste the lease and the review becomes available.'}
          {' '}The checks below still run — they read your records, not the document.
        </p>
      )}
      {/* The findings most worth having are the ones that say a lease is SILENT on
          something. An unread page looks exactly like silence, so when the transcript
          has holes this has to be said BEFORE the list, not as a footnote after it. */}
      {hasText && gaps.partial && (
        <div className="note-msg warn">
          <strong>Only part of this document could be read.</strong>{' '}
          {gaps.pages.length > 0 && <>Pages {gaps.pages.join(', ')} didn’t transcribe. </>}
          {barelyRead
            ? 'Almost nothing usable came through, so any finding below is unreliable — it may be describing a page that was never read, or a document that isn’t the lease.'
            : 'A finding that says the lease doesn’t mention something may just mean it’s on a page that wasn’t read.'}
          {' '}Re-upload a clearer scan, then re-review.
        </div>
      )}
      {run.isError && <div className="note-msg danger">{run.error?.message || 'The review couldn’t be completed — please try again.'}</div>}
      {/* Dismissing a finding writes a row too, and said nothing when it failed — the
          finding simply stayed on screen, which reads as the button not working. */}
      <MutationError of={[dismiss]} />
      {stale && (
        <p className="muted review-note">
          This lease has changed since the AI last read it{review?.reviewed_at ? ` on ${fmtDate(String(review.reviewed_at).slice(0, 10))}` : ''}.
          Re-review to take the latest riders into account.
        </p>
      )}

      {flags.length === 0 ? (
        /* Silent when the AI half was marked read: the note above already says what was
           folded away, and "the AI found no missing protections" would flatly contradict
           it. */
        dismissedCount > 0 ? null : (
          <p className="empty-line muted">
            {review || codeFlags.length === 0
              ? 'Nothing flagged. The records are complete and the AI found no missing protections it could name.'
              : 'Nothing flagged from your records yet. Run the review to have the lease itself read.'}
          </p>
        )
      ) : (
        <>
          <div className="review-list">
            {(open ? flags : flags.slice(0, 3)).map((f) => (
              <div key={`${f.source}-${f.key}`} className={`review-item ${f.severity}`}>
                <div className="review-item-head">
                  <span className={`badge ${TONE[f.severity] || 'info'}`}>{f.severity === 'high' ? 'Look at this' : f.severity === 'medium' ? 'Worth checking' : 'For your information'}</span>
                  <strong>{f.title}</strong>
                  {/* ⚠ ONLY THE DOCUMENT FINDINGS CARRY A DISMISS. The record checks below
                      them are recomputed from live data on every render — silencing an
                      expired certificate here would keep it silent while it went on being
                      expired. They clear themselves the moment the record is fixed, which
                      is the same promise a dismiss makes, kept properly. */}
                  {f.source === 'ai' && (
                    <button
                      type="button"
                      className="icon-btn review-item-x"
                      disabled={dismiss.isPending}
                      title="Mark this one read — it folds away and comes off this tenant's flag"
                      aria-label={`Mark read: ${f.title}`}
                      onClick={() => dismiss.mutate([...dismissedKeys, f.key])}
                    >
                      ✕
                    </button>
                  )}
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
