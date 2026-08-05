import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listDocuments, deleteDocument, deleteLeaseFile, updateLease, uploadDoc, signDocUrl,
  uploadNewLeaseDocument, applyNewLeaseTerms, getLease, buildScheduleFromExtraction,
} from '../lib/api';
import { fmtDate, money } from '../lib/format';
import { initialFromExtraction } from '../pages/LeaseNewPage';
import { newLeaseChanges, newLeaseTargets, hasNoChanges } from '../lib/newLeaseTerms';
import { stripVerdicts, mismatchPhrase } from '../lib/analystBrief';
import { settleBillingChange, settleLeaseScheduleChange } from '../lib/invalidate';
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
                "Add a file" only while the lease had NONE. Named for what it is — George,
                2026-08-04: *"if i replace a lease with a new one id want the figures to
                change based on the new lease thats the point so it should say 'upload new
                lease'"* — because "Replace" sounded like swapping a file, and this updates
                the lease's terms. */}
            {/* ⚠ NOT gated on `newest` any more. A lease entered by hand has no document, and
                uploading its first one used to go through the plain "Add a file" path — stored,
                never read, no diff, no figures. That is the one lease whose figures were never
                AI-checked at all. uploadNewLeaseDocument already handles a lease with no
                lease_files row (it inserts one), so the only thing that was missing was the
                way in. */}
            {!isLoading && (
              <button
                type="button" className="ghost btn-sm" disabled={busy}
                title="Upload a new lease for this tenant. Amlak reads it, shows you what changes, and updates the lease's terms once you confirm."
                onClick={() => replaceRef.current?.click()}
              >Upload {newest ? 'new ' : ''}lease</button>
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
        onChange={onReplacePicked} aria-label="Upload a new lease for this tenant"
      />
      {pending && (
        <NewLeaseModal
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

// Uploading a NEW lease for a tenant who already has one — the thing George actually wanted
// when he asked for a re-upload button: *"if i replace a lease with a new one id want the
// figures to change based on the new lease thats the point."*
//
// It runs in two stages on purpose, and the split is the whole design:
//
//   READ   — the file is stored, the lease is pointed at it, the text is re-read and the
//            document's terms are extracted. Nothing on the lease's figures moves.
//   APPLY  — only after he has seen a line-by-line list of what changes, from → to.
//
// Base rent and square footage are billed figures: they feed the invoice, the ledger and
// every tenant's share of CAM (CLAUDE.md §1). "The figures change" must never mean "the
// figures changed and nobody said which" — so the list he approves IS the object that gets
// written, and the stored invoice is resynced afterwards because it does not rebuild itself.
//
// ⚠ THE MIDDLE STATE IS REAL AND IS NAMED. Between the two stages the new document is
// already the lease's document while the terms are still the old ones. Every path out of
// here says which of those two things is true rather than showing a bare error.
function NewLeaseModal({ leaseId, file, current, onClose, onDone }) {
  const qc = useQueryClient();
  const [keepOld, setKeepOld] = useState(true);
  const [phase, setPhase] = useState('ask'); // ask | reading | review | applying | done | failed
  const [read, setRead] = useState(null);    // { extraction, length }
  const [changes, setChanges] = useState(null);
  const [plan, setPlan] = useState(null);    // the schedule rows the review below shows
  const [applied, setApplied] = useState(null);
  const [err, setErr] = useState('');

  async function readIt() {
    setPhase('reading'); setErr('');
    try {
      const res = await uploadNewLeaseDocument({
        leaseId, file, oldDocId: current?.id || null, keepOld,
      });
      setRead(res);
      // The document is the lease's document from this moment, whatever happens next.
      onDone?.();
      const lease = await getLease(leaseId);
      const ex = res.extraction || {};
      const proposed = initialFromExtraction(ex);
      // Two passes, and the order is forced: the rent schedule has to be dated off the rent
      // and start date the lease WILL HAVE, which is only known once the field diff exists —
      // and the diff's counts have to be the rows that will actually be written, not the raw
      // ones the document printed. Both passes read identical field inputs, so the fields
      // they produce are the same object twice; only the counts differ.
      const fieldsOnly = newLeaseChanges({ lease, proposed, extraction: ex });
      const built = buildScheduleFromExtraction(ex, newLeaseTargets(lease, fieldsOnly));
      setPlan(built);
      setChanges(newLeaseChanges({ lease, proposed, extraction: ex, plan: built }));
      setPhase('review');
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
      onDone?.();
    }
  }

  async function applyIt() {
    setPhase('applying'); setErr('');
    try {
      // The plan goes with it: the steps written are the steps he just read, not a second
      // derivation that could have moved between the review and the button.
      const res = await applyNewLeaseTerms({ leaseId, changes, plan, extraction: read?.extraction });
      setApplied(res);
      qc.invalidateQueries({ queryKey: ['lease', leaseId] });
      // The rent steps, the options and the abatement windows were all replaced, and each
      // renders from its own per-lease key — including the lease-review strip's lapsed-option
      // warning, which would otherwise still be describing the option this document retired.
      settleLeaseScheduleChange(qc, leaseId);
      // The billed figures moved, so every screen that reads them has to repaint. One
      // shared set rather than a hand-rolled list — hand-rolled lists drift by omission.
      settleBillingChange(qc, {
        propertyId: res.propertyId, leaseId, year: new Date().getFullYear(),
      });
      setPhase('done');
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
    }
  }

  const busyPhase = phase === 'reading' || phase === 'applying';
  // What the extractor said about the DOCUMENT, as opposed to about the figures. Read off the
  // same extraction the apply stores, so the dialog can't show one thing and save another.
  const aiFlags = Array.isArray(read?.extraction?.ai_review?.flags) ? read.extraction.ai_review.flags : [];
  const mismatches = Array.isArray(read?.extraction?.extraction_mismatch) ? read.extraction.extraction_mismatch : [];
  const brief = typeof read?.extraction?.analysis_brief === 'string' ? read.extraction.analysis_brief : '';
  const show = (f, v) => {
    if (v === null || v === undefined || v === '') return '—';
    // "net" / "gross" is the whole difference between billing CAM & tax on top of the rent
    // and carving them out of it, so it is spelled out rather than shown as the raw word.
    if (f.key === 'lease_type') {
      return v === 'gross' ? 'Gross — CAM & tax inside the rent' : 'Net — CAM & tax billed on top';
    }
    if (f.kind === 'money') return money(v);
    if (f.kind === 'date') return fmtDate(v);
    if (f.kind === 'number') return Number(v).toLocaleString();
    return String(v);
  };

  return (
    <div className="modal-scrim" onClick={busyPhase ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 620 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>
            {phase === 'done' ? 'New lease applied'
              : phase === 'review' ? 'Apply the new lease?'
                : 'Upload a new lease'}
          </strong>
          {!busyPhase && <button className="icon-btn" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">
          {phase === 'ask' && (
            <>
              <p className="note-msg info" style={{ marginTop: 0 }}>
                <strong>{file.name}</strong> becomes this lease’s document
                {current?.filename ? <>, in place of <strong>{current.filename}</strong></> : null}.
              </p>
              <div className="confirm-imp info">
                <p className="confirm-imp-title">What this does</p>
                <ul>
                  <li>
                    Amlak <strong>reads the new lease</strong> — its rent, dates, size, rent
                    step-ups and renewal options — and replaces the saved text so the assistant,
                    the lease search and the AI review all answer from it.
                  </li>
                  <li>
                    Then it shows you <strong>exactly which figures change</strong>, old and new,
                    and nothing is updated until you say so.
                  </li>
                  <li>
                    Applying it <strong>updates this tenant’s bill</strong> for the current year.
                    A year you have already closed is left alone.
                  </li>
                </ul>
              </div>

              <p className="doc-choice-head">The old lease document</p>
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
                <button type="button" onClick={readIt}>Read the new lease</button>
                <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              </div>
            </>
          )}

          {phase === 'reading' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Uploading <strong>{file.name}</strong> and reading it… A scanned lease can take a
              minute or two.
            </p>
          )}

          {phase === 'review' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ Read <strong>{Number(read?.length || 0).toLocaleString()} characters</strong> from{' '}
                {file.name}. The saved text now comes from this document.
              </p>

              {/* ── WHAT THE AI ITSELF FLAGGED ───────────────────────────────────────────
                  All four of these are emitted by extract-lease and rendered on the
                  new-tenant intake screen; none of them reached this dialog, which is the
                  one where the figures are about to move on a lease that already exists.
                  The red flags mattered most: applying WRITES ai_review onto the lease, so
                  the landlord met them only after committing. George: *"the lease extractor
                  needs to be as good as the original one we made for the new tenants."* */}
              {aiFlags.length > 0 && (
                <div className="note-msg warn">
                  <strong>⚑ The AI flagged {aiFlags.length} thing{aiFlags.length === 1 ? '' : 's'} in this document</strong>
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    {aiFlags.map((fl, i) => (
                      <li key={fl.key || i}>{fl.title}{fl.note ? <span className="muted"> — {fl.note}</span> : null}</li>
                    ))}
                  </ul>
                </div>
              )}
              {mismatches.length > 0 && (
                <p className="note-msg warn">
                  ⚠ The AI’s notes say this lease carries <strong>{mismatchPhrase(mismatches)}</strong> that
                  didn’t land on the figures below. Check {mismatches.length === 1 ? 'it' : 'those'} against
                  the document before applying.
                </p>
              )}
              {read?.extraction?.rent_schedule_flag && (
                <p className="note-msg warn">⚠ {String(read.extraction.rent_schedule_flag)}</p>
              )}

              {/* A guessed date is not a stated one, and this dialog has no fields to correct
                  it in — so it is dropped rather than applied. George, 2026-08-05. */}
              {(changes?.guessedDates || []).map((g) => (
                <p className="note-msg warn" key={`g-${g.key}`}>
                  ⚠ The document prints no <strong>{g.label.toLowerCase()}</strong>. The nearest thing
                  on it is {g.from} ({fmtDate(g.value)}), which is a guess — so the lease keeps its own{' '}
                  {g.label.toLowerCase()} and nothing is changed. Set it by hand on the lease page if the
                  document is clear about it elsewhere.
                </p>
              ))}
              {(changes?.unusableDates || []).map((u) => (
                <p className="note-msg warn" key={`u-${u.key}`}>
                  ⚠ The <strong>{u.label.toLowerCase()}</strong> reads <strong>{u.printed}</strong>, which
                  isn’t a real date on the calendar. It is left unchanged — everything else in this
                  document still applies.
                </p>
              ))}

              {hasNoChanges(changes) ? (
                <p className="note-msg info">
                  It states the same terms already on the lease, so there is nothing to update.
                </p>
              ) : (
                <>
                  <p className="doc-choice-head">What changes on the lease</p>
                  <table className="terms-diff">
                    <thead>
                      <tr><th>&nbsp;</th><th>Now</th><th>New lease</th></tr>
                    </thead>
                    <tbody>
                      {changes.fields.map((f) => (
                        <tr key={f.key} className={f.billed ? 'billed' : undefined}>
                          <th scope="row">{f.label}</th>
                          <td className="was">{show(f, f.from)}</td>
                          <td className="now">{show(f, f.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!changes.fields.length && (
                    <p className="muted" style={{ fontSize: 12.5 }}>
                      No stored figure changes — only the schedule below.
                    </p>
                  )}
                  {/* The schedule itself, dated — not a count of it. George, 2026-08-04:
                      *"if the rent escalation in the new lease is found the ledger needs to
                      show, the lease terms need to update, the renewal options need to
                      update."* A step is only real once it has a date; showing the dates is
                      what lets him check them against the document in front of him before
                      any of it reaches the ledger. */}
                  {plan?.escalations?.length > 0 && (
                    <>
                      <p className="doc-choice-head">The new lease’s rent schedule</p>
                      {plan.freeMonths > 0 && (
                        <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
                          Rent commences <strong>{plan.freeMonths} month{plan.freeMonths === 1 ? '' : 's'}</strong> after
                          the start date — the steps below are dated from there, not from the term start.
                        </p>
                      )}
                      <table className="terms-diff schedule">
                        <tbody>
                          {plan.escalations.map((e) => (
                            <tr key={`e-${e.effective_date}`}>
                              <th scope="row">{fmtDate(e.effective_date)}</th>
                              <td className="now">{money(e.new_base_rent)}<span className="muted"> / yr</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {plan?.optionSteps?.length > 0 && (
                    <p className="muted" style={{ fontSize: 12.5 }}>
                      The renewal option is priced year by year — <strong>{plan.optionSteps.length} further
                      step{plan.optionSteps.length === 1 ? '' : 's'}</strong> from {fmtDate(plan.optionSteps[0].effective_date)} at{' '}
                      {money(plan.optionSteps[0].new_base_rent)}/yr are saved past the term end and shown
                      as <em>pending renewal</em>. They only become real rent if the option is confirmed.
                    </p>
                  )}
                  {changes.undated > 0 && (
                    <p className="note-msg warn">
                      ⚠ <strong>{changes.undated}</strong> rent step
                      {changes.undated === 1 ? '' : 's'} in the document {changes.undated === 1 ? 'has' : 'have'} no
                      date the lease start can place {changes.undated === 1 ? 'it' : 'them'} on, so
                      {changes.undated === 1 ? ' it is' : ' they are'} not saved. Add{' '}
                      {changes.undated === 1 ? 'it' : 'them'} by hand on the Rent schedule after applying.
                    </p>
                  )}
                  <ul className="terms-extra">
                    <li>
                      <strong>{changes.escalations || 'No'}</strong> rent step-up
                      {changes.escalations === 1 ? '' : 's'} in the new lease
                      {changes.escalations === 1 ? ' replaces' : ' replace'} any not-yet-applied
                      steps on this one. Steps already applied stay in the history.
                    </li>
                    <li>
                      <strong>{changes.renewals || 'No'}</strong> renewal option
                      {changes.renewals === 1 ? '' : 's'}
                      {changes.renewals === 1 ? ' replaces' : ' replace'} any still pending. An
                      option already exercised or lapsed stays as it is.
                    </li>
                    {changes.abatements > 0 && (
                      <li>
                        <strong>{changes.abatements}</strong> rent abatement
                        {changes.abatements === 1 ? '' : 's'} are added. Existing ones are left
                        alone — one may already have credited an invoice.
                      </li>
                    )}
                    {changes.touchesBilling && (
                      <li>
                        This tenant’s <strong>invoice for {new Date().getFullYear()} is rebuilt</strong>{' '}
                        from the new figures. A closed year is skipped.
                        {/* Square footage is the numerator of the CAM / tax split, and when the
                            property has no building size on file it is also part of the
                            DENOMINATOR (Σ leased SF) — so resizing one tenant re-splits them
                            all. This used to say "this tenant" while the code rebuilt the whole
                            property; the done screen below now reports which actually happened. */}
                        {changes.fields.some((f) => f.key === 'square_footage') && (
                          <> If this property has no building size on file, square footage is the
                          share denominator — so <strong>every tenant’s invoice</strong> here is
                          rebuilt, not just this one.</>
                        )}
                      </li>
                    )}
                    {/* A lease whose first step is already in the past is the ordinary case,
                        not an edge case — and the rent it lands on is NOT the figure printed
                        on page one. Saying so here is the difference between that reading as
                        a feature and reading as a bug. */}
                    {plan?.escalations?.some((e) => e.effective_date <= new Date().toISOString().slice(0, 10)) && (
                      <li>
                        Step-ups already dated in the past are applied on the way in, so the rent
                        ends at <strong>today’s</strong> figure from this schedule — not the starting
                        rent printed on the document.
                      </li>
                    )}
                  </ul>
                </>
              )}

              {brief && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>Read the AI analyst’s notes</summary>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    What the AI understood from reading the whole document — check it against the table
                    above before applying.
                  </div>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 6, fontFamily: 'inherit' }}>
                    {stripVerdicts(brief)}
                  </pre>
                </details>
              )}

              <div className="row" style={{ marginTop: 16 }}>
                {!hasNoChanges(changes) && (
                  <button type="button" onClick={applyIt}>Apply the new lease</button>
                )}
                <button type="button" className="ghost" onClick={onClose}>
                  {hasNoChanges(changes) ? 'Done' : 'Keep the current figures'}
                </button>
              </div>
              {!hasNoChanges(changes) && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Keeping the current figures leaves the lease exactly as it is — the new document
                  and its text stay either way.
                </p>
              )}
            </>
          )}

          {phase === 'applying' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Updating the lease and rebuilding this tenant’s bill…
            </p>
          )}

          {phase === 'done' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ The lease now reads from <strong>{file.name}</strong>.
                {' '}{applied?.fields || 0} figure{applied?.fields === 1 ? '' : 's'} updated,
                {' '}{applied?.escalations || 0} rent step-up{applied?.escalations === 1 ? '' : 's'} and
                {' '}{applied?.renewals || 0} renewal option{applied?.renewals === 1 ? '' : 's'} on file.
              </p>
              {applied?.currentRent != null && (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  The rent in effect today is <strong>{money(applied.currentRent)}/yr</strong> — the new
                  lease’s schedule rolled forward to {fmtDate(new Date().toISOString().slice(0, 10))}.
                  {applied?.optionSteps > 0 && (
                    <> Another {applied.optionSteps} step{applied.optionSteps === 1 ? '' : 's'} sit past the
                    term end as <em>pending renewal</em>.</>
                  )}
                </p>
              )}
              <p className="muted" style={{ fontSize: 12.5 }}>
                {!applied?.resynced && 'No billed figure moved, so no invoice needed rebuilding. '}
                {applied?.resyncScope === 'property' && (
                  <>Because this property has no building size on file, square footage is the share
                  denominator — so <strong>{applied.leasesResynced} tenant
                  {applied.leasesResynced === 1 ? '’s bill' : 's’ bills'}</strong> on it were rebuilt,
                  not just this one; a closed year was skipped. </>
                )}
                {applied?.resyncScope === 'lease' && 'This tenant’s bill for the current year has been rebuilt from the new figures; a closed year was skipped. '}
                It is recorded in the property’s history, with every figure’s old and new value.
              </p>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <>
              {/* ⚠ THIS USED TO PROMISE "nothing was half-changed". It isn't true and it
                  isn't ours to promise: applying is a sequence of separate writes (the lease
                  row, then the rent steps, the estimate ledger, the options, the abatements),
                  and a failure part way through leaves the earlier ones committed. The
                  new-tenant path IS atomic — create_lease_tx, migration 0053 — but there is no
                  equivalent transaction for applying over an existing lease. Telling the
                  landlord to check is honest and actionable; telling him it's fine is neither. */}
              <p className="note-msg warn" style={{ marginTop: 0 }}>
                {read
                  ? <>
                      The new lease was read, but applying its terms stopped part way through.{' '}
                      <strong>Some figures may already have changed and others not</strong> — check
                      the lease page against the document, then try again. Applying the same
                      document twice is safe: the rent steps and renewal options are replaced
                      rather than added to.
                    </>
                  : <>
                      <strong>{file.name}</strong> was saved and is now this lease’s document, but it
                      couldn’t be read. <strong>The saved text and every figure are still the
                      previous lease’s</strong> — nothing was lost.
                    </>}
              </p>
              <p className="note-msg danger">{err}</p>
              <div className="row" style={{ marginTop: 14 }}>
                {read && <button type="button" onClick={applyIt}>Try applying again</button>}
                <button type="button" className="ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
