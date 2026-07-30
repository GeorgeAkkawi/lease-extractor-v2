import { useState } from 'react';
import { signDocUrl } from '../lib/api';
import { coversLabel, riderTitle, sortRiders, riderHasText } from '../lib/riders';
import DocumentsList from './DocumentsList';

// "Open rider" — directly under "Open lease", one row per rider.
//
// George, 2026-07-30: "we have an open lease and right under make an open rider
// button (input the dates of the rider)".
//
// The text was already there and already being READ: buildLeaseAskContext has fed
// every rider's addendum_text to the assistant since 2026-07-01, so the AI could
// answer about an amendment the landlord had no way to open. `addendums` is already
// in scope on the lease page (it's passed to buildLeaseAskContext) and listAddendums
// does select('*') — so the text and the storage path are ALREADY in the client
// cache. This costs no query.
//
// Oldest first, so reading down the list walks the lease forward through time.
export default function RiderDocs({ riders = [] }) {
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');
  const ordered = sortRiders(riders);
  if (!ordered.length) return null;

  const open = ordered.find((r) => r.id === openId) || null;

  async function openFile(path) {
    setErr('');
    try {
      const url = await signDocUrl(path);
      if (url) window.open(url, '_blank', 'noopener');
      else setErr('That file is no longer in storage.');
    } catch (e) { setErr(e.message || String(e)); }
  }

  return (
    <>
      <div className="rider-rows">
        {ordered.map((r) => {
          const hasText = riderHasText(r);
          const isOpen = r.id === openId;
          return (
            <div className="rider-row" key={r.id}>
              <span className="rider-row-name">
                {riderTitle(r)} <span className="rider-row-dates">· {coversLabel(r)}</span>
              </span>
              {/* A pasted rider has cached text but no file; an uploaded one usually
                  has both. Neither button is invented when there's nothing behind it. */}
              {hasText && (
                <button type="button" className="ghost btn-sm" onClick={() => setOpenId(isOpen ? null : r.id)}>
                  {isOpen ? 'Hide rider' : 'Open rider'}
                </button>
              )}
              {r.storage_path && (
                <button type="button" className="ghost btn-sm" onClick={() => openFile(r.storage_path)}>Open file</button>
              )}
              {!hasText && !r.storage_path && (
                <span className="muted rider-row-dates">No copy on file</span>
              )}
            </div>
          );
        })}
      </div>
      {err && <p className="note-msg danger" style={{ marginTop: -6, marginBottom: 12 }}>{err}</p>}
      {/* The SAME .lease-doc scroll box the lease itself opens into — a rider reads
          like the lease because it is the same kind of thing. */}
      {open && riderHasText(open) && (
        <>
          <div className="lease-doc">{open.addendum_text}</div>
          {/* The open rider's own saved copies — mounted only while it's open, so a
              lease with six riders doesn't fire six list queries on page load. */}
          <DocumentsList
            entityType="addendum"
            entityId={open.id}
            title={`Saved copies — ${riderTitle(open)}`}
            addLabel="Add a copy"
            emptyText="No file on file for this rider — it was pasted in. Add a copy to keep the signed original here."
          />
        </>
      )}
    </>
  );
}
