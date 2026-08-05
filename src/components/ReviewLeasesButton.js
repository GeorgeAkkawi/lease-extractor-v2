import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reviewLeases, getHiddenWidgets } from '../lib/api';
import { useConfirm } from './ConfirmDialog';

// Runs the AI red-flag review across every lease on a property in one click, reading
// any lease's document first when its searchable text never got cached.
//
// WHY A SWEEP EXISTS AT ALL. The ten-check review (0069) shipped 2026-07-29 and only
// runs automatically on NEW imports, so every lease imported before that date has a
// null ai_review — on George's portfolio that was all 15. The per-lease ↻ button on the
// lease page could fix them one at a time; nobody is going to click it fifteen times.
//
// ⚠ IT DOES NOT QUOTE A PRICE (George, 2026-08-05: "take out how much it costs, the user
// doesn't care about that"). It is still click-gated and still confirmed — the dialog
// exists to say what the action DOES and what it will not touch, which is the part a
// landlord actually weighs. Nothing here writes a lease term: reviewLease saves only
// `ai_review`, cacheLeaseText saves only `lease_text`. A sweep can never move a billed
// figure.

// The findings this sweep produces land in the lease page's "Lease review" panel — which
// the landlord can hide from Settings › Display. Hidden, the sweep would run and write
// findings that render NOWHERE in the app. The preference is not overridden (it is his
// choice); it is said out loud, before the run and again after.
const HIDDEN_NOTE = 'The Lease review panel is hidden in Settings › Display — turn it on to read the findings on each lease.';
const useLeaseReviewHidden = () => {
  const { data: hiddenWidgets = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  return hiddenWidgets.includes('lease_review');
};

export default function ReviewLeasesButton({ leases = [], onResults, onProgress }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [running, setRunning] = useState(false);

  const panelHidden = useLeaseReviewHidden();
  const total = leases.length;

  const run = async () => {
    const ok = await askConfirm({
      title: `Review ${total} lease${total === 1 ? '' : 's'}?`,
      message: 'Each lease is read for terms that commonly cost a landlord money — no personal guarantee, no late fee, an uncapped CAM, and seven more.',
      implications: [
        `Every tenant on this property is read — ${total} lease${total === 1 ? '' : 's'}, one at a time.`,
        'Any lease whose document hasn’t been read yet is transcribed first, so nothing is judged on a blank page.',
        'Nothing is written to any lease’s terms — this only fills the red-flag panel.',
        ...(panelHidden ? [HIDDEN_NOTE] : []),
      ],
      confirmLabel: 'Review leases',
      // Accent, not red: this is a READ. danger-solid is reserved for permanent deletes
      // (ConfirmDialog.js) and made a review look like it destroyed something.
      tone: 'default',
    });
    if (!ok) return;

    // ⚠ EVERYTHING THE SWEEP DRAWS IS HANDED UP, and that is a layout fix, not tidiness.
    // The button lives inside .head-actions, a plain flex row. Rendering the progress line
    // or the report here — both full-width — stretched "Download rent roll", "Review
    // leases" and "Building size" to the height of whatever was rendered beside them
    // (George, 2026-08-05). The row now only ever holds buttons.
    onResults?.(null);
    setRunning(true);
    onProgress?.({ done: 0, total, current: null });
    const res = await reviewLeases(leases, { onProgress });
    setRunning(false);
    onProgress?.(null);
    onResults?.(res);
    // The reviews live on the lease rows; refresh both the list and any open lease so
    // LeaseReviewStrip shows the new findings without a reload. `leaseReviews` is the
    // light per-property read behind the tenant-row badges — without it the sweep
    // finishes and the list it just came from still shows no flags.
    qc.invalidateQueries({ queryKey: ['leases'] });
    qc.invalidateQueries({ queryKey: ['lease'] });
    qc.invalidateQueries({ queryKey: ['leaseReviews'] });
  };

  return (
    <button className="secondary" onClick={run} disabled={!total || running}
      title="Check every lease on this property for terms that could cost you money">
      {running ? 'Reviewing…' : '⚑ Review leases'}
    </button>
  );
}

/**
 * What the sweep is doing, and then what it found.
 *
 * DELIBERATELY NOT A LIST OF LEASES (George, 2026-08-05: "just say leases reviewed, found
 * this, then have a dismiss button"). It briefly was one, because a bare total answered
 * nothing about WHERE to look — but the answer to that is now the flag badge on each
 * tenant row, which is durable and survives navigating away. Saying it twice made the
 * report a wall of names that had to be re-read every sweep. The two are not
 * interchangeable: this says the run finished, the badges say which lease to open.
 *
 * A FAILURE IS STILL NAMED. "Reviewed 8 of 9" without saying which one didn't is the one
 * shape of this panel that leaves the landlord unable to act.
 */
export function ReviewResults({ results, progress, onDismiss }) {
  const panelHidden = useLeaseReviewHidden();

  if (progress) {
    return (
      <div className="note-msg review-results">
        <span>
          Reviewing {Math.min(progress.done + 1, progress.total)} of {progress.total}
          {progress.current ? ` — ${progress.current}` : ''}…
        </span>
      </div>
    );
  }
  if (!results) return null;

  const failed = results.filter((r) => !r.ok);
  const okRows = results.filter((r) => r.ok);
  const findings = okRows.reduce((s, r) => s + (r.flags || 0), 0);
  const read = okRows.filter((r) => r.cached).length;

  return (
    <div className="note-msg review-results">
      <div className="review-results-head">
        <strong>
          Reviewed {okRows.length} of {results.length} lease{results.length === 1 ? '' : 's'}
          {read > 0 && ` · read ${read} document${read === 1 ? '' : 's'} for the first time`}
          {/* "found in the documents", not "to look at": this counts the AI half only. The
              lease page adds the free checks read from the landlord's own records, so its
              total runs higher — naming the half each number counts stops that difference
              reading as a bug. Same wording as the tenant-row badge. */}
          {` · ${findings} found in the document${findings === 1 ? '' : 's'}`}
        </strong>
        {onDismiss && <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">✕</button>}
      </div>
      {failed.length > 0 && (
        <div className="review-result-rows">
          {failed.map((f) => (
            <div key={f.id} className="review-result-row failed">
              <span className="rvw-tenant">⚠ {f.tenant_name}</span>
              <span className="rvw-count">{f.error}</span>
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5 }}>
        {panelHidden ? HIDDEN_NOTE : 'Each lease now carries its own flag on the list below — open one to read what was found.'}
      </div>
    </div>
  );
}
