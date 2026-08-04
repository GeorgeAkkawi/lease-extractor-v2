import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listDocuments, deleteDocument, deleteLeaseFile, updateLease, uploadDoc, signDocUrl } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useConfirm } from './ConfirmDialog';

// The lease's own document, in exactly the shape a rider has — George, 2026-08-04:
// *"now follow the same format as the riders. Lease - read text - add/open file whichever
// is there."*
//
//   LEASE
//     Lease · Jun 1, 2017 → May 31, 2027     [Read text] [Open file]
//   RIDERS
//     First Amendment · Jul 2024 → Jun 2027  [Read text] [Open file]
//
// This replaces the "Saved copies of the lease" list + the assistant's own status row.
// Those were two blocks describing one document in two different formats, which is what
// made the panel hard to read: a heading that said a copy was saved, a button that opened
// something else, and an add control beside a list that already had the file in it.
//
// A lease holds ONE document, by George's own rule — its next version arrives as an
// ADDENDUM (AI-read on the way in), not as another copy. So the row offers `Open file`
// when there is one and `Add a file` when there isn't, and nothing else.
//
// EARLIER COPIES still show. Accounts predate the one-document rule (the demo seed has
// two), and a file that exists must stay reachable — but they sit under the lease as
// plainly-labelled extra rows, each removable, rather than as a titled list that competes
// with the lease itself. Delete them and the block collapses to the single row.
export default function LeaseDocs({ leaseId, leaseText, termLabel = '' }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const key = ['documents', 'lease', leaseId];
  const { data: docs = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => listDocuments('lease', leaseId),
    enabled: !!leaseId,
  });

  const hasText = !!(leaseText && leaseText.trim());
  // coversLabel's "nothing known" fallback — don't print a dash as if it were a period.
  const term = termLabel && termLabel !== '—' ? termLabel : '';
  const newest = docs[0] || null; // listDocuments orders newest first
  const older = docs.slice(1);

  // The bucket is private, so opening a document means minting a short-lived signed URL
  // first. New tab, so the app keeps its state.
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
    if (!file) return;
    setErr(''); setBusy(true);
    try {
      await uploadDoc(file, { entityType: 'lease', entityId: leaseId });
      qc.invalidateQueries({ queryKey: key });
    } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
  }

  // The lease's CURRENT file. George, 2026-08-04: *"there should be a remove button which
  // pops up and says delete file (deleting this file will also cause the saved text to
  // delete as well — make sure this is true)"*. It IS true: deleteLeaseFile clears
  // leases.lease_text in the same call, which is why the dialog leads with that line
  // rather than burying it. The row falls back to "Add a file" and the paste box
  // reappears, so there is always a way back.
  async function removeFile(d) {
    if (await askConfirm({
      title: 'Delete this file?',
      message: `“${d.filename || 'This document'}” will be removed from storage.`,
      implications: [
        'The saved text goes with it — the assistant will have no copy of this lease to read until a new file is added or the text is pasted back in.',
        'The file itself is permanently deleted — this can’t be undone.',
        'Everything already recorded on the lease stays: the rent, dates, square footage and terms, and every rider with its own text and file.',
      ],
      confirmLabel: 'Delete file',
      tone: 'danger',
    })) {
      setErr(''); setBusy(true);
      try {
        await deleteLeaseFile(d.id, leaseId);
        setOpen(false); // the text it was showing no longer exists
        qc.invalidateQueries({ queryKey: key });
        // lease_text lives on the lease row, not in the document registry — without this
        // the row would keep offering "Read text" for text that has just been deleted.
        qc.invalidateQueries({ queryKey: ['lease', leaseId] });
      } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
    }
  }

  // Text pasted straight in, with no file behind it — the same case as a pasted rider, and
  // it kept the same block from having any remove button at all. The lease keeps this in
  // step with RiderDocs deliberately: the two blocks are one shape, and a ✕ that appeared
  // on one and not the other would be the "two formats for one thing" problem returning.
  async function removeText() {
    if (await askConfirm({
      title: 'Delete the saved text?',
      message: 'The plain-text copy of this lease will be removed.',
      implications: [
        'The assistant will have nothing to read for this lease until text is pasted back in or a file is added.',
        'This can’t be undone — the text is not kept anywhere else, and there is no file to re-read it from.',
        'Everything already recorded on the lease stays: the rent, dates, square footage and terms, and every rider.',
      ],
      confirmLabel: 'Delete text',
      tone: 'danger',
    })) {
      setErr(''); setBusy(true);
      try {
        await updateLease(leaseId, { lease_text: null });
        setOpen(false);
        qc.invalidateQueries({ queryKey: ['lease', leaseId] });
      } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
    }
  }

  // An EARLIER copy is a different thing and says so: it is not the source of the cached
  // text (the current file above it is), so deleting one takes the file only.
  async function removeCopy(d) {
    if (await askConfirm({
      title: 'Delete this copy?',
      message: `“${d.filename || 'This document'}” will be removed from storage.`,
      implications: [
        'The file itself is permanently deleted — this can’t be undone.',
        'Everything the AI already read from it stays: the cached text, the extracted terms and the lease itself are untouched.',
        'The current copy of the lease is not affected.',
      ],
      confirmLabel: 'Delete copy',
      tone: 'danger',
    })) {
      try {
        await deleteDocument(d.id);
        qc.invalidateQueries({ queryKey: key });
      } catch (ex) { setErr(ex.message || String(ex)); }
    }
  }

  if (!leaseId) return null;

  return (
    /* .rider-group is the shape — same heading, same rows, same two action columns as the
       riders below. .lease-group only names which block this is, for tests and for anyone
       reading the DOM; it carries no style of its own. */
    <div className="rider-group lease-group">
      <div className="rider-head">Lease</div>
      <div className="rider-rows">
        <div className="rider-row">
          <span className="rider-row-name">
            Lease{term ? <span className="rider-row-dates"> · {term}</span> : null}
            {!hasText && <span className="rider-row-dates"> · no text saved yet</span>}
          </span>
          {/* The same three-slot group every row on this panel uses, so "Read text" ends in
              one column, the file action in the next and the ✕ in the last — whether or
              not the row happens to have all three. */}
          <span className="doc-actions">
            {hasText && (
              <button type="button" className="ghost btn-sm" onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide text' : 'Read text'}
              </button>
            )}
            <span className="doc-act2">
              {newest ? (
                <button type="button" className="ghost btn-sm" onClick={() => openFile(newest.storage_path)}>Open file</button>
              ) : !isLoading ? (
                <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? 'Saving…' : 'Add a file'}
                </button>
              ) : null}
            </span>
            {/* One ✕ for whatever the row is holding: the file (and the text that came out
                of it), or — with nothing on file — the pasted text on its own. */}
            <span className="doc-act3">
              {newest ? (
                <button
                  type="button" className="icon-btn danger-btn" title="Delete this file"
                  disabled={busy} onClick={() => removeFile(newest)}
                >✕</button>
              ) : hasText ? (
                <button
                  type="button" className="icon-btn danger-btn" title="Delete the saved text"
                  disabled={busy} onClick={removeText}
                >✕</button>
              ) : null}
            </span>
          </span>
        </div>

        {older.map((d) => (
          <div className="rider-row" key={d.id}>
            <span className="rider-row-name">
              Earlier copy
              <span className="rider-row-dates"> · {d.filename || 'document'} · {fmtDate(d.created_at)}</span>
            </span>
            {/* Its two controls sit in the SAME two columns as the lease's above — the
                "Read text" slot is simply empty, because an earlier copy has no cached
                text of its own. */}
            <span className="doc-actions">
              <span className="doc-act2">
                <button type="button" className="ghost btn-sm" onClick={() => openFile(d.storage_path)}>Open file</button>
              </span>
              <span className="doc-act3">
                <button type="button" className="icon-btn danger-btn" title="Delete this copy" onClick={() => removeCopy(d)}>✕</button>
              </span>
            </span>
          </div>
        ))}
      </div>

      <input
        ref={fileRef} type="file" accept=".pdf,.docx,image/*" style={{ display: 'none' }}
        onChange={onFile} aria-label="Add a document to this lease"
      />
      {err && <p className="note-msg danger" style={{ marginTop: -6, marginBottom: 12 }}>{err}</p>}
      {/* The same .lease-doc scroll box a rider opens into — the lease reads like its
          riders because it is the same kind of thing. */}
      {open && hasText && <div className="lease-doc">{leaseText}</div>}
    </div>
  );
}
