import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listDocuments, deleteDocument, deleteLeaseFile, updateLease, uploadDoc, signDocUrl, replaceLeaseFile } from '../lib/api';
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
  const replaceRef = useRef(null);
  const [pending, setPending] = useState(null); // the file chosen for a replacement

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

  // A replacement is chosen here and committed in the dialog — never straight from the
  // file picker. Swapping the document the assistant reads is not something that should
  // happen the instant a file is selected.
  function onReplacePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) { setErr(''); setPending(file); }
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
            {/* The control George couldn't find, because it did not exist: the row offered
                "Add a file" only while the lease had NONE. */}
            {newest && (
              <button
                type="button" className="ghost btn-sm" disabled={busy}
                title="Upload a newer copy of this lease. Amlak re-reads it and replaces the saved text; the lease’s own figures don’t change."
                onClick={() => replaceRef.current?.click()}
              >Replace</button>
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
      <input
        ref={replaceRef} type="file" accept=".pdf,.docx,image/*" style={{ display: 'none' }}
        onChange={onReplacePicked} aria-label="Replace this lease's document"
      />
      {pending && (
        <ReplaceLeaseModal
          leaseId={leaseId}
          file={pending}
          current={newest}
          onClose={() => setPending(null)}
          onDone={() => {
            // Collapse the text panel if it happens to be open. The refetch replaces what
            // it holds, but leaving the PREVIOUS document's text on screen for even a beat
            // after being told the text was replaced is the exact confusion this feature
            // exists to remove.
            setOpen(false);
            qc.invalidateQueries({ queryKey: key });
            qc.invalidateQueries({ queryKey: ['lease', leaseId] });
          }}
        />
      )}
      {err && <p className="note-msg danger" style={{ marginTop: -6, marginBottom: 12 }}>{err}</p>}
      {/* The same .lease-doc scroll box a rider opens into — the lease reads like its
          riders because it is the same kind of thing. */}
      {open && hasText && <div className="lease-doc">{leaseText}</div>}
    </div>
  );
}

// Replacing the document a lease is read from, with the two things George asked for around
// it: it says what is about to happen BEFORE it happens, and it asks what to do with the
// old file rather than deciding for him.
//
// It also reports the outcome in the only terms that mean anything here — how much text
// came back and whether it cost anything — because "done" alone would not tell him whether
// the assistant can now answer from the new document.
//
// ⚠ THE FAILURE STATE IS THE ONE THAT MATTERS. If the new file lands but can't be read (a
// photo of a photo, a scan too faint to transcribe), the lease is now pointing at the new
// document while the SAVED TEXT is still the old one's. That is a genuinely confusing state
// and the dialog names it exactly rather than showing a generic error.
function ReplaceLeaseModal({ leaseId, file, current, onClose, onDone }) {
  const [keepOld, setKeepOld] = useState(true);
  const [phase, setPhase] = useState('ask'); // ask | working | done | failed
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function go() {
    setPhase('working'); setErr('');
    try {
      const res = await replaceLeaseFile({
        leaseId, file, oldDocId: current?.id || null, keepOld,
      });
      setResult(res);
      setPhase('done');
      onDone?.();
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
      // The file IS swapped by the time a read can fail, so the panel has to refresh even
      // on this path or it would keep showing the previous document as current.
      onDone?.();
    }
  }

  const done = phase === 'done';
  const chars = Number(result?.length || 0);

  return (
    <div className="modal-scrim" onClick={phase === 'working' ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{done ? 'Lease document replaced' : 'Replace the lease document?'}</strong>
          {phase !== 'working' && <button className="icon-btn" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">
          {phase === 'ask' && (
            <>
              <p className="note-msg info" style={{ marginTop: 0 }}>
                <strong>{file.name}</strong> becomes this lease’s document
                {current?.filename ? <>, in place of <strong>{current.filename}</strong></> : null}.
              </p>
              {/* Same block the delete dialogs use, in its informational tone — this is a
                  change worth explaining, not a destruction worth alarming about. */}
              <div className="confirm-imp info">
                <p className="confirm-imp-title">What this does</p>
                <ul>
                  <li>
                    Amlak <strong>re-reads the new document straight away</strong> and replaces the
                    saved text. The lease assistant, the lease search and the AI review all start
                    answering from it.
                  </li>
                  <li>
                    <strong>The lease’s own figures do not change.</strong> Rent, dates, square
                    footage, escalations and renewal options stay exactly as they are — a new
                    document never moves a billed figure on its own.
                  </li>
                  <li>
                    If this is a genuinely new lease rather than a better copy of this one, add it
                    as a <strong>new lease</strong> instead, so the old term stays in the history.
                  </li>
                </ul>
              </div>

              <p className="doc-choice-head">The old file</p>
              <label className="doc-choice">
                <input type="radio" name="oldfile" checked={keepOld} onChange={() => setKeepOld(true)} />
                <span>
                  Keep it on record
                  <small className="muted">It stays under the lease as an earlier copy and can still be opened.</small>
                </span>
              </label>
              <label className="doc-choice">
                <input type="radio" name="oldfile" checked={!keepOld} onChange={() => setKeepOld(false)} />
                <span>
                  Delete it
                  <small className="muted">Permanently removed from storage. This can’t be undone.</small>
                </span>
              </label>

              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" onClick={go}>Replace and re-read</button>
                <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              </div>
            </>
          )}

          {phase === 'working' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Uploading <strong>{file.name}</strong> and reading it… A scanned lease can take a
              minute or two.
            </p>
          )}

          {done && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ Read <strong>{chars.toLocaleString()} characters</strong> from {file.name}. The
                saved text now comes from this document.
              </p>
              <p className="muted" style={{ fontSize: 12.5 }}>
                {result?.source === 'transcription'
                  ? 'It was a scan, so it was transcribed by AI.'
                  : 'It carried its own text layer, so it was read for free — no AI call.'}
                {' '}The lease’s rent, dates, square footage and terms were not touched;
                {' '}{keepOld ? 'the previous file is still on record below.' : 'the previous file was deleted.'}
              </p>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <>
              <p className="note-msg warn" style={{ marginTop: 0 }}>
                <strong>{file.name}</strong> was saved and is now this lease’s document, but it
                couldn’t be read. <strong>The saved text is still the previous document’s</strong> —
                nothing was lost, but the assistant is answering from the older copy until this is
                fixed.
              </p>
              <p className="note-msg danger">{err}</p>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
