import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { reviewLeases, leaseNeedsText } from '../lib/api';
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

// Rough per-lease costs, used only to state a figure before the user commits. A review is
// Haiku over already-cached text; reading a document is the expensive half and is free
// when the file is a digital PDF (its text layer is read locally, no model call), so the
// quoted number is a ceiling rather than a bill.
const REVIEW_CENTS = 4;
const READ_CENTS = 25;

const money = (cents) => (cents < 100 ? `${Math.round(cents)}¢` : `$${(cents / 100).toFixed(2)}`);

export default function ReviewLeasesButton({ leases = [] }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [progress, setProgress] = useState(null); // {done,total,current} while running
  const [results, setResults] = useState(null);

  const total = leases.length;
  const needText = leases.filter(leaseNeedsText).length;
  const estimate = total * REVIEW_CENTS + needText * READ_CENTS;

  const run = async () => {
    const ok = await askConfirm({
      title: `Review ${total} lease${total === 1 ? '' : 's'}?`,
      message: 'Each lease is read for terms that commonly cost a landlord money — no personal guarantee, no late fee, an uncapped CAM, and seven more.',
      implications: [
        `${total} lease${total === 1 ? '' : 's'} will be reviewed.`,
        ...(needText
          ? [`${needText} ${needText === 1 ? 'has' : 'have'} no searchable text yet and will be read first (free if the file is a digital PDF).`]
          : []),
        `About ${money(estimate)} in total, one time.`,
        'Nothing is written to any lease’s terms — this only fills the red-flag panel.',
      ],
      confirmLabel: 'Review leases',
    });
    if (!ok) return;

    setResults(null);
    setProgress({ done: 0, total, current: null });
    const res = await reviewLeases(leases, { onProgress: setProgress });
    setProgress(null);
    setResults(res);
    // The reviews live on the lease rows; refresh both the list and any open lease so
    // LeaseReviewStrip shows the new findings without a reload.
    qc.invalidateQueries({ queryKey: ['leases'] });
    qc.invalidateQueries({ queryKey: ['lease'] });
  };

  const running = !!progress;
  const failed = results?.filter((r) => !r.ok) || [];
  const okRows = results?.filter((r) => r.ok) || [];
  const findings = okRows.reduce((s, r) => s + (r.flags || 0), 0);
  const read = okRows.filter((r) => r.cached).length;

  return (
    <>
      <button className="secondary" onClick={run} disabled={!total || running}
        title={`Check every lease on this property for terms that could cost you money. About ${money(estimate)}, one time.`}>
        {running ? `Reviewing ${Math.min(progress.done + 1, total)} of ${total}…` : '⚑ Review leases'}
      </button>
      {running && progress.current && (
        <div className="muted" style={{ fontSize: 11, width: '100%', textAlign: 'right' }}>{progress.current}</div>
      )}
      {results && (
        <div className="note-msg" style={{ width: '100%' }}>
          Reviewed {okRows.length} of {results.length} lease{results.length === 1 ? '' : 's'}
          {read > 0 && ` · read ${read} document${read === 1 ? '' : 's'} for the first time`}
          {` · ${findings} finding${findings === 1 ? '' : 's'}`}
          {failed.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {failed.map((f) => (
                <div key={f.id}>⚠ {f.tenant_name}: {f.error}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
