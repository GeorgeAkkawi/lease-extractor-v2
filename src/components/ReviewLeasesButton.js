import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
// It is deliberately CLICK-GATED and confirmed with a cost, because each lease is a paid
// model read. Nothing here writes a lease term: reviewLease saves only `ai_review`, and
// cacheLeaseText saves only `lease_text`. A sweep can never move a billed figure.

// A review is Haiku over already-cached text. READ_CENTS is the ceiling for the OTHER
// half — transcribing a document that was never read — and is quoted as a possibility
// rather than added to the total, see the estimate note below.
const REVIEW_CENTS = 4;
const READ_CENTS = 25;

const money = (cents) => (cents < 100 ? `${Math.round(cents)}¢` : `$${(cents / 100).toFixed(2)}`);

// The findings this sweep pays for land in the lease page's "Lease review" panel — which
// the landlord can hide from Settings › Display. Hidden, the sweep would charge for ten
// findings that render NOWHERE in the app. The preference is not overridden (it is his
// choice); it is said out loud, before the money and again after.
const HIDDEN_NOTE = 'The Lease review panel is hidden in Settings › Display — turn it on to read the findings on each lease.';
const useLeaseReviewHidden = () => {
  const { data: hiddenWidgets = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  return hiddenWidgets.includes('lease_review');
};

export default function ReviewLeasesButton({ leases = [], onResults }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [progress, setProgress] = useState(null); // {done,total,current} while running

  const panelHidden = useLeaseReviewHidden();

  const total = leases.length;
  // ⚠ THE ESTIMATE DELIBERATELY DOES NOT COUNT WHICH LEASES NEED TRANSCRIBING.
  // It used to: `leases.filter(leaseNeedsText).length`. But these rows come from
  // listLeases → LEASE_LIST_COLS, which OMITS lease_text on purpose (a full lease is tens
  // of KB and no list needs it), so lease_text was `undefined` on every row and
  // leaseNeedsText answered true for all of them — quoting total × 29¢ where the truth was
  // total × 4¢ ($2.61 vs 36¢ on George's nine). It read correctly in the demo and only in
  // the demo, because mockClient's builder ignores column lists (mockClient.js:187) so its
  // rows carry the text. Quote the half the page can actually derive, and DESCRIBE the
  // other half rather than inventing a count for it.
  const estimate = total * REVIEW_CENTS;

  const run = async () => {
    const ok = await askConfirm({
      title: `Review ${total} lease${total === 1 ? '' : 's'}?`,
      message: 'Each lease is read for terms that commonly cost a landlord money — no personal guarantee, no late fee, an uncapped CAM, and seven more.',
      implications: [
        `${total} lease${total === 1 ? '' : 's'} will be reviewed — about ${money(estimate)} in total, one time (${REVIEW_CENTS}¢ each).`,
        `Any lease whose document hasn’t been read yet is transcribed first — free for a digital PDF, up to ~${READ_CENTS}¢ for a large scan.`,
        'Nothing is written to any lease’s terms — this only fills the red-flag panel.',
        ...(panelHidden ? [HIDDEN_NOTE] : []),
      ],
      confirmLabel: 'Review leases',
      // Accent, not red: this is a paid READ. danger-solid is reserved for permanent
      // deletes (ConfirmDialog.js) and made a review look like it destroyed something.
      tone: 'default',
    });
    if (!ok) return;

    onResults?.(null);
    setProgress({ done: 0, total, current: null });
    const res = await reviewLeases(leases, { onProgress: setProgress });
    setProgress(null);
    // Handed UP rather than rendered here: the report belongs across the page, not wedged
    // between the header's buttons where it squeezed them out of shape.
    onResults?.(res);
    // The reviews live on the lease rows; refresh both the list and any open lease so
    // LeaseReviewStrip shows the new findings without a reload. `leaseReviews` is the
    // light per-property read behind the tenant-row badges — without it the sweep
    // finishes and the list it just came from still shows no flags.
    qc.invalidateQueries({ queryKey: ['leases'] });
    qc.invalidateQueries({ queryKey: ['lease'] });
    qc.invalidateQueries({ queryKey: ['leaseReviews'] });
  };

  const running = !!progress;

  return (
    <>
      <button className="secondary" onClick={run} disabled={!total || running}
        title={`Check every lease on this property for terms that could cost you money. About ${money(estimate)}, one time.`}>
        {running ? `Reviewing ${Math.min(progress.done + 1, total)} of ${total}…` : '⚑ Review leases'}
      </button>
      {running && progress.current && (
        <div className="muted" style={{ fontSize: 11, width: '100%', textAlign: 'right' }}>{progress.current}</div>
      )}
    </>
  );
}

/**
 * What the sweep found — A LIST, NOT A COUNT (George, 2026-08-05: "it just says leases
 * reviewed and 10 findings — how does the user know where to look or what to do").
 *
 * A portfolio total is unactionable: the findings are saved per lease, on a page this
 * report is the only signpost to. So every reviewed lease gets a row naming it, how bad it
 * is, and a click through to the panel holding its findings — including the clean ones, so
 * the sweep visibly accounts for every lease rather than leaving the landlord to guess
 * which of them the total came from.
 *
 * This report still dies on navigation. The DURABLE answer is the flag badge on each
 * tenant row (LeasesPage) — the two are built from the same numbers on purpose.
 */
export function ReviewResults({ results, corpId, propId, onDismiss }) {
  const navigate = useNavigate();
  const panelHidden = useLeaseReviewHidden();
  if (!results) return null;

  const failed = results.filter((r) => !r.ok);
  const okRows = results.filter((r) => r.ok);
  const findings = okRows.reduce((s, r) => s + (r.flags || 0), 0);
  const read = okRows.filter((r) => r.cached).length;
  // Worst first — the tenant with severe findings is the one to open, and a list in
  // whatever order the sweep happened to run buries them.
  const ranked = [...okRows].sort((a, b) => (b.high || 0) - (a.high || 0) || (b.flags || 0) - (a.flags || 0));
  const canOpen = !!corpId && !!propId;

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
      <div className="review-result-rows">
        {ranked.map((r) => (
          <button
            key={r.id}
            type="button"
            className="review-result-row"
            onClick={() => canOpen && navigate(`/leases/${corpId}/${propId}/${r.id}`)}
            disabled={!canOpen}
            title={r.flags ? `Open ${r.tenant_name} to read the findings` : `${r.tenant_name} — nothing found in the document`}
          >
            <span className="rvw-tenant">{r.tenant_name}</span>
            <span className={`rvw-count${r.high ? ' high' : r.flags ? ' warn' : ''}`}>
              {r.flags
                ? `${r.high ? `${r.high} high · ` : ''}${r.flags} found`
                : 'nothing found'}
            </span>
            {canOpen && r.flags > 0 && <span className="rvw-go">›</span>}
          </button>
        ))}
        {failed.map((f) => (
          <div key={f.id} className="review-result-row failed">
            <span className="rvw-tenant">⚠ {f.tenant_name}</span>
            <span className="rvw-count">{f.error}</span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {panelHidden ? HIDDEN_NOTE : 'Saved on each lease — re-opening a tenant costs nothing.'}
      </div>
    </div>
  );
}
