import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signDocUrl, uploadDoc, updateAddendum } from '../lib/api';
import { coversLabel, riderTitle, sortRiders, riderHasText } from '../lib/riders';

// One row per rider, directly under the lease's own row, offering the SAME two actions in
// the same order as every other document on this panel:
//
//   Read text  — the cached transcription (this is what the AI assistant reads)
//   Open file  — the signed document itself, in a new tab
//
// George, 2026-08-04: *"it's pretty confusing what the difference is between opening the
// cached leases and riders that are saved and then opening the physical copy"* — they were
// four different words ("Open lease", "Open", "Open rider", "Open file") for two things.
// Now the verb names the action, not the object, and the pair is identical on every row.
//
// A rider with no document shows **Add a file** RIGHT HERE. It used to be reachable only by
// opening the rider first and finding a copies list nested under its text — George's other
// complaint, and a genuinely undiscoverable path.
//
// The text was already there and already being READ: buildLeaseAskContext has fed every
// rider's addendum_text to the assistant since 2026-07-01, so the AI could answer about an
// amendment the landlord had no way to open. `addendums` is already in scope on the lease
// page and listAddendums does select('*') — so the text and the storage path are ALREADY in
// the client cache. Reading the file state off storage_path (rather than the documents
// registry) is what keeps this free: a lease with six riders fires no extra queries.
//
// Oldest first, so reading down the list walks the lease forward through time.
export default function RiderDocs({ riders = [], leaseId }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const fileRef = useRef(null);
  const forRider = useRef(null); // which row opened the (single, shared) file picker
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

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    const rider = forRider.current;
    forRider.current = null;
    if (!file || !rider) return;
    setErr(''); setBusyId(rider.id);
    try {
      // Registered against the rider (so it joins the document registry like every other
      // saved file) AND written to the rider's own storage_path, which is what this row
      // reads — without that write the button would stay on "Add a file" until a reload.
      const path = await uploadDoc(file, { entityType: 'addendum', entityId: rider.id });
      await updateAddendum(rider.id, { storage_path: path });
      qc.invalidateQueries({ queryKey: leaseId ? ['addendums', leaseId] : ['addendums'] });
      qc.invalidateQueries({ queryKey: ['documents', 'addendum', rider.id] });
    } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusyId(null); }
  }

  return (
    <div className="rider-group">
      {/* Labelled to match "Saved copies of the lease" above it. Without a heading the
          rows read as stray buttons hanging off the assistant — the thing George could
          not make sense of at a glance. */}
      <div className="rider-head">Riders</div>
      <div className="rider-rows">
        {ordered.map((r) => {
          const hasText = riderHasText(r);
          const isOpen = r.id === openId;
          const busy = busyId === r.id;
          return (
            <div className="rider-row" key={r.id}>
              <span className="rider-row-name">
                {riderTitle(r)} <span className="rider-row-dates">· {coversLabel(r)}</span>
              </span>
              {/* A pasted rider has cached text but no file; an uploaded one usually has
                  both. Neither action is invented when there's nothing behind it — but a
                  missing FILE is now an invitation to add one rather than a dead end. The
                  trailing slot is always laid out, so "Read text" ends in the same column
                  as the lease's and the saved copies' buttons. */}
              <span className="doc-actions">
                {hasText && (
                  <button type="button" className="ghost btn-sm" onClick={() => setOpenId(isOpen ? null : r.id)}>
                    {isOpen ? 'Hide text' : 'Read text'}
                  </button>
                )}
                <span className="doc-act2">
                  {r.storage_path ? (
                    <button type="button" className="ghost btn-sm" onClick={() => openFile(r.storage_path)}>Open file</button>
                  ) : (
                    <button
                      type="button" className="ghost btn-sm" disabled={busy}
                      onClick={() => { forRider.current = r; fileRef.current?.click(); }}
                    >{busy ? 'Saving…' : 'Add a file'}</button>
                  )}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <input
        ref={fileRef} type="file" accept=".pdf,.docx,image/*" style={{ display: 'none' }}
        onChange={onFile} aria-label="Add a document to this rider"
      />
      {err && <p className="note-msg danger" style={{ marginTop: -6, marginBottom: 12 }}>{err}</p>}
      {/* The SAME .lease-doc scroll box the lease itself opens into — a rider reads
          like the lease because it is the same kind of thing.

          There is deliberately NO nested copies list under it any more. A rider holds one
          document (the signed original, attached at creation), so a version drawer here
          only ever showed the same file the row already offers — and it hid the add
          control behind opening the rider. Deleting a rider still takes its file with it
          (deleteAddendum → deleteDocumentsFor). */}
      {open && riderHasText(open) && <div className="lease-doc">{open.addendum_text}</div>}
    </div>
  );
}
