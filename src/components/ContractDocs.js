import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  uploadNewContractDocument, applyNewContractTerms, getServiceContract,
  countBilledTenants, listContractEscalations, readSignedContractEnvelope, markEnvelopeApplied,
} from '../lib/api';
import { fmtDate, money, currentYear } from '../lib/format';
import { contractChanges, contractTargets, buildContractFeeSteps, hasNoContractChanges } from '../lib/contractTerms';
import { contractAnnualCost } from '../lib/contracts';
import { stripVerdicts, mismatchPhrase } from '../lib/analystBrief';
import { settleBillingChange, settleContractChange } from '../lib/invalidate';

// "2025", "2025 and 2026", "2024, 2025 and 2026" — a contract change reaches every fiscal
// year it covers, not just the one on screen, so these notes have to be able to name several.
const listYears = (ys) => {
  const a = (ys || []).map(Number).filter(Boolean).sort((x, y) => x - y);
  if (!a.length) return '';
  if (a.length === 1) return String(a[0]);
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
};

// What the contract carry-through actually did, in the landlord's terms. Written ONCE and
// rendered by both result panels (the read-the-document flow and the save-terms flow) — they
// had two identical copies of this paragraph, which is how one of them would have kept saying
// "for 2026" after the carry-through learned to reach 2025 as well.
function CarryThroughNote({ applied }) {
  if (!applied) return null;
  const closed = applied.closedYears || [];
  return (
    <p className="muted" style={{ fontSize: 12.5 }}>
      {!applied.synced && 'The CAM line item was already at this figure, so nothing needed rebuilding. '}
      {closed.length > 0 &&
        `${listYears(closed)} ${closed.length === 1 ? 'is closed, so its bills were' : 'are closed, so their bills were'} left exactly as they were. `}
      {applied.lockUnknown &&
        'One year couldn’t be checked for a closed snapshot, so it was left untouched — try again once you’re back online. '}
      {applied.resynced && (
        <><strong>{applied.leasesResynced} tenant{applied.leasesResynced === 1 ? '’s bill' : 's’ bills'}</strong>{' '}
        for {listYears(applied.rebuiltYears)} were rebuilt from the new CAM total. Tenants on a CAM &amp; tax
        estimate were not touched — they settle the difference at ⚖ Reconcile. </>
      )}
      {applied.failed > 0 && (
        <strong className="note-msg warn" style={{ display: 'inline' }}>
          {applied.failed} bill{applied.failed === 1 ? '' : 's'} could NOT be rebuilt and{' '}
          {applied.failed === 1 ? 'is' : 'are'} still billed the old CAM figure — the property’s
          History names them; use Rebuild on the Ledger row.{' '}
        </strong>
      )}
      It is recorded in the property’s history, with every figure’s old and new value.
    </p>
  );
}

// Uploading a contract document over a contract that already exists — the contracts-tab
// twin of LeaseDocs' "Upload new lease", and it exists for the same reason. George,
// 2026-08-05: *"we need to add the same system to the contracts tab."*
//
// Before this, a contract's document could only ever be attached at ADD time, and even then
// the extraction was spread straight into an insert with no diff, no confirmation and no
// history entry. There was no way to upload a renewed contract at all.
//
// It runs in two stages, and the split is the whole design:
//
//   READ   — the file is stored, the contract is pointed at it, and its cached text is
//            replaced so the assistant answers from the new document. No figure moves.
//   APPLY  — only after the landlord has seen a line-by-line list of what changes.
//
// A contract's fee is a billed figure: it becomes a CAM line item → expense_records.cam_total
// → every tenant's share → a stored invoice (CLAUDE.md §1). "The figures change" must never
// mean "the figures changed and nobody said which".
const FREQ_LABEL = { annual: 'per year', monthly: 'per month', 'one-time': 'one-time' };
const TYPE_LABEL = { landscaping: 'Landscaping', snow_removal: 'Snow removal', security: 'Security', other: 'Other' };

// ⚠ NOT gated on whether a document exists. The button reads "Upload contract" when there
// is none and "Upload new contract" when there is — the same fix the lease side needed,
// because a contract entered by hand is exactly the one whose figures were never AI-checked.
export default function ContractDocs({ contract, onChanged, droppedFile = null, onDroppedTaken }) {
  const pickRef = useRef(null);
  const [pending, setPending] = useState(null);

  function onPicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) setPending(file);
  }

  // A file dragged onto the contract card (ServiceContractsSection) arrives here, so a drop
  // and the button below open the SAME review dialog. The parent's copy is released as soon
  // as this one holds it — the File is the state, and two owners would reopen the dialog.
  useEffect(() => {
    if (droppedFile) { setPending(droppedFile); onDroppedTaken?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFile]);

  return (
    <>
      <button
        type="button" className="ghost btn-sm"
        title="Upload the contract document — or drag it anywhere onto this contract. Amlak reads it, shows you what changes, and updates the contract's terms once you confirm."
        onClick={() => pickRef.current?.click()}
      >Upload {contract?.storage_path ? 'new ' : ''}contract</button>
      <input
        ref={pickRef} type="file" accept=".pdf,.docx,image/*" style={{ display: 'none' }}
        onChange={onPicked} aria-label="Upload a contract document"
      />
      {pending && (
        <NewContractModal
          contract={contract}
          file={pending}
          onClose={() => setPending(null)}
          onDone={onChanged}
        />
      )}
    </>
  );
}

function NewContractModal({ contract, file, onClose, onDone }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState('ask'); // ask | reading | review | applying | done | failed
  const [read, setRead] = useState(null);    // { extraction, length }
  const [changes, setChanges] = useState(null);
  const [plan, setPlan] = useState(null);
  const [applied, setApplied] = useState(null);
  const [err, setErr] = useState('');

  async function readIt() {
    setPhase('reading'); setErr('');
    try {
      const res = await uploadNewContractDocument({ contractId: contract.id, file });
      setRead(res);
      // The document is this contract's document from this moment, whatever happens next.
      onDone?.();
      const fresh = await getServiceContract(contract.id);
      const ex = res.extraction || {};
      // Two passes, and the order is forced: the fee schedule has to be dated and annualized
      // off the frequency and start date the contract WILL HAVE, which is only known once the
      // field diff exists — and the diff's counts have to be the rows that will actually be
      // written, not the raw ones the document printed.
      const fieldsOnly = contractChanges({ contract: fresh, extraction: ex });
      const built = buildContractFeeSteps(ex, contractTargets(fresh, fieldsOnly));
      setPlan(built);
      setChanges(contractChanges({ contract: fresh, extraction: ex, plan: built }));
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
      const res = await applyNewContractTerms({
        contractId: contract.id, changes, plan, extraction: read?.extraction,
      });
      setApplied(res);
      // The contract, its steps, the derived CAM row and the history log.
      settleContractChange(qc, res.propertyId);
      // …and every money screen downstream of cam_total. One shared set rather than a
      // hand-rolled list — hand-rolled lists drift by omission.
      settleBillingChange(qc, { propertyId: res.propertyId, year: res.year });
      setPhase('done');
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
    }
  }

  const busyPhase = phase === 'reading' || phase === 'applying';

  return (
    <div className="modal-scrim" onClick={busyPhase ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 620 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>
            {phase === 'done' ? 'New contract applied'
              : phase === 'review' ? 'Apply the new contract?'
                : 'Upload a contract'}
          </strong>
          {!busyPhase && <button className="icon-btn" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">
          {phase === 'ask' && (
            <>
              <p className="note-msg info" style={{ marginTop: 0 }}>
                <strong>{file.name}</strong> becomes this contract’s document.
              </p>
              <div className="confirm-imp info">
                <p className="confirm-imp-title">What this does</p>
                <ul>
                  <li>
                    Amlak <strong>reads the contract</strong> — its fee, term, fee schedule,
                    whether it renews itself and the cancellation notice it requires — and
                    replaces the saved text so the assistant answers from it.
                  </li>
                  <li>
                    Then it shows you <strong>exactly which figures change</strong>, old and new,
                    and nothing is updated until you say so.
                  </li>
                  <li>
                    Applying it <strong>updates what this contract carries into CAM</strong> for the
                    current year. A year you have already closed is left alone.
                  </li>
                </ul>
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" onClick={readIt}>Read the contract</button>
                <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              </div>
            </>
          )}

          {phase === 'reading' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Uploading <strong>{file.name}</strong> and reading it… A scanned contract can take
              a minute.
            </p>
          )}

          {phase === 'review' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ Read <strong>{Number(read?.length || 0).toLocaleString()} characters</strong> from{' '}
                {file.name}. The saved text now comes from this document.
              </p>
              <ContractReview
                contract={contract}
                extraction={read?.extraction}
                changes={changes}
                plan={plan}
              />
              <div className="row" style={{ marginTop: 16 }}>
                {!hasNoContractChanges(changes) && (
                  <button type="button" onClick={applyIt}>Apply the new contract</button>
                )}
                <button type="button" className="ghost" onClick={onClose}>
                  {hasNoContractChanges(changes) ? 'Done' : 'Keep the current figures'}
                </button>
              </div>
              {!hasNoContractChanges(changes) && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Keeping the current figures leaves the contract exactly as it is — the new
                  document and its text stay either way.
                </p>
              )}
            </>
          )}

          {phase === 'applying' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Updating the contract and rebuilding what it carries into CAM…
            </p>
          )}

          {phase === 'done' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ The contract now reads from <strong>{file.name}</strong>.
                {' '}{applied?.fields || 0} figure{applied?.fields === 1 ? '' : 's'} updated,
                {' '}{applied?.feeSteps || 0} dated fee step{applied?.feeSteps === 1 ? '' : 's'} on file.
              </p>
              <CarryThroughNote applied={applied} />
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <>
              <p className="note-msg warn" style={{ marginTop: 0 }}>
                {read
                  ? <>
                      The contract was read, but applying its terms stopped part way through.{' '}
                      <strong>Some figures may already have changed and others not</strong> — check
                      the contract against the document, then try again. Applying the same
                      document twice is safe: the fee schedule is replaced rather than added to,
                      and the CAM line item only moves when the figure actually differs.
                    </>
                  : <>
                      <strong>{file.name}</strong> was saved and is now this contract’s document, but
                      it couldn’t be read. <strong>Every figure is still the previous
                      contract’s</strong> — nothing was lost.
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

/**
 * The countersigned contract, read in. George, 2026-08-05: *"then it should send and only
 * when its countersigned the user should be prompted with extract info with AI then it
 * should upload."*
 *
 * ⚠ THE PROMPT IS DELIBERATELY AT THE END OF THE CHAIN, not the start. Reading the document
 * on the way OUT would transcribe terms that were still being negotiated — the point of
 * sending it for signature is that the version that matters is the one that comes back. So
 * the button only exists once the envelope is executed, and it reads `executed_path`: the
 * document plus both signatures plus the certificate.
 *
 * Everything after that is the same machine as an uploaded document — the same review, the
 * same diff, the same carry-through into CAM — because it is the same question: what does
 * this contract now say, and what does that change about what the tenants are billed?
 *
 * ⚠ BOTH BUTTONS CLEAR THE PROMPT. "Apply" stamps applied_at through applyNewContractTerms;
 * "File it" stamps it directly. A landlord who reads a renewal, sees it restates the same
 * figures, and closes the dialog has ACTED on it — leaving the row nagging (and the dashboard
 * alert with it) would teach him to ignore the one prompt that means money hasn't moved yet.
 */
export function SignedContractModal({ contract, envelope, onClose, onDone }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState('ask'); // ask | reading | review | applying | done | failed
  const [read, setRead] = useState(null);
  const [changes, setChanges] = useState(null);
  const [plan, setPlan] = useState(null);
  const [applied, setApplied] = useState(null);
  const [err, setErr] = useState('');

  async function readIt() {
    setPhase('reading'); setErr('');
    try {
      const res = await readSignedContractEnvelope({ envelopeId: envelope.id, contractId: contract.id });
      setRead(res);
      // The cached text is the signed document's from this moment, so the assistant answers
      // from it whatever the landlord decides about the figures.
      onDone?.();
      const fresh = res.contract || await getServiceContract(contract.id);
      const ex = res.extraction || {};
      // Two passes, same forced order as the upload path: the fee schedule has to be dated
      // and annualized off the frequency and start date the contract WILL HAVE.
      const fieldsOnly = contractChanges({ contract: fresh, extraction: ex });
      const built = buildContractFeeSteps(ex, contractTargets(fresh, fieldsOnly));
      setPlan(built);
      setChanges(contractChanges({ contract: fresh, extraction: ex, plan: built }));
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
      const res = await applyNewContractTerms({
        contractId: contract.id, changes, plan, extraction: read?.extraction, envelopeId: envelope.id,
      });
      setApplied(res);
      settleContractChange(qc, res.propertyId);
      settleBillingChange(qc, { propertyId: res.propertyId, year: res.year });
      setPhase('done');
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
    }
  }

  async function fileWithoutChanges() {
    setPhase('applying'); setErr('');
    try {
      await markEnvelopeApplied(envelope.id);
      settleContractChange(qc, contract.property_id);
      setApplied({ fields: 0, feeSteps: 0, filedOnly: true });
      setPhase('done');
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase('failed');
    }
  }

  const busyPhase = phase === 'reading' || phase === 'applying';
  const nothingToApply = hasNoContractChanges(changes);

  return (
    <div className="modal-scrim" onClick={busyPhase ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 620 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>
            {phase === 'done' ? 'Signed contract filed'
              : phase === 'review' ? 'Apply the signed contract?'
                : 'Read the signed contract'}
          </strong>
          {!busyPhase && <button className="icon-btn" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">
          {phase === 'ask' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ <strong>{envelope.title}</strong> is signed by both parties
                {envelope.executed_at ? <> — completed {fmtDate(String(envelope.executed_at).slice(0, 10))}</> : null}.
              </p>
              <div className="confirm-imp info">
                <p className="confirm-imp-title">What this does</p>
                <ul>
                  <li>
                    Amlak reads the <strong>signed copy</strong> — not the draft you sent — for its
                    fee, term, fee schedule, renewal, cancellation notice and whether it names you
                    as additional insured.
                  </li>
                  <li>
                    Then it shows you <strong>exactly which figures change</strong> on{' '}
                    <strong>{contract?.name || contract?.vendor || 'this contract'}</strong>, old and
                    new. Nothing is updated until you say so.
                  </li>
                  <li>
                    Applying it <strong>updates what this contract carries into CAM</strong> for the
                    current year, and rebuilds this year’s bills from it. A year you have already
                    closed is left alone.
                  </li>
                </ul>
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" onClick={readIt}>Read the signed contract</button>
                <button type="button" className="ghost" onClick={onClose}>Not now</button>
              </div>
            </>
          )}

          {phase === 'reading' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Reading the signed copy of <strong>{envelope.title}</strong>… A scanned contract can
              take a minute.
            </p>
          )}

          {phase === 'review' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ Read <strong>{Number(read?.length || 0).toLocaleString()} characters</strong> from
                the signed copy. The saved text now comes from it.
              </p>
              <ContractReview
                contract={read?.contract || contract}
                extraction={read?.extraction}
                changes={changes}
                plan={plan}
              />
              <div className="row" style={{ marginTop: 16 }}>
                {!nothingToApply && (
                  <button type="button" onClick={applyIt}>Apply the signed contract</button>
                )}
                <button type="button" className={nothingToApply ? undefined : 'ghost'}
                  onClick={fileWithoutChanges}>
                  {nothingToApply ? 'File it' : 'File it — keep the current figures'}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Either way this document stops asking to be read. The signed copy stays on the
                contract, and its text is already saved.
              </p>
            </>
          )}

          {phase === 'applying' && (
            <p className="note-msg info" style={{ marginTop: 0 }}>
              Filing the signed contract and rebuilding what it carries into CAM…
            </p>
          )}

          {phase === 'done' && (
            <>
              <p className="note-msg good" style={{ marginTop: 0 }}>
                ✓ <strong>{envelope.title}</strong> is filed.
                {applied?.filedOnly
                  ? ' Its figures were left exactly as they were.'
                  : <> {applied?.fields || 0} figure{applied?.fields === 1 ? '' : 's'} updated,
                    {' '}{applied?.feeSteps || 0} dated fee step{applied?.feeSteps === 1 ? '' : 's'} on file.</>}
              </p>
              {!applied?.filedOnly && (
                <CarryThroughNote applied={applied} />
              )}
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <>
              <p className="note-msg warn" style={{ marginTop: 0 }}>
                {read
                  ? <>
                      The signed contract was read, but filing it stopped part way through.{' '}
                      <strong>Some figures may already have changed and others not</strong> — check
                      the contract against the signed copy, then try again. Doing it twice is safe:
                      the fee schedule is replaced rather than added to, and the CAM line item only
                      moves when the figure actually differs.
                    </>
                  : <>
                      The signed copy couldn’t be read. <strong>Every figure on this contract is
                      unchanged</strong>, and the signed document is still on file — nothing was lost.
                    </>}
              </p>
              <p className="note-msg danger">{err}</p>
              <div className="row" style={{ marginTop: 14 }}>
                {read
                  ? <button type="button" onClick={applyIt}>Try applying again</button>
                  : <button type="button" onClick={readIt}>Try reading again</button>}
                <button type="button" className="ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ⚠ A BOOLEAN'S WORDS BELONG TO ITS FIELD, not to its type. "Yes" and "No" mean different
// things on "does this renew itself?" than on "are you named as additional insured?", and a
// single pair for kind==='bool' printed "Yes — renews unless cancelled" against an insurance
// answer the moment a second boolean field existed.
const BOOL_WORDS = {
  auto_renew: ['Yes — renews unless cancelled', 'No — ends at the term'],
  additional_insured: ['Yes — the contract requires it', 'No — not required by this contract'],
};

const show = (f, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (f.key === 'frequency') return FREQ_LABEL[v] || String(v);
  if (f.key === 'service_type') return TYPE_LABEL[v] || String(v);
  if (f.kind === 'bool') return (BOOL_WORDS[f.key] || ['Yes', 'No'])[v ? 0 : 1];
  if (f.kind === 'money') return money(v);
  if (f.kind === 'date') return fmtDate(v);
  if (f.kind === 'number') return Number(v).toLocaleString();
  return String(v);
};

/**
 * The review body, shared by BOTH entry points — the replace-document modal above and
 * AddContract. Sharing it is the point: Add was the only contract path with no diff, no
 * confirmation and no history entry, and giving it its own second renderer would have left
 * the two able to disagree about what a document says.
 *
 * For a new contract, `contract` is a blank object, so every field reads as an addition.
 */
export function ContractReview({ contract, extraction, changes, plan, isNew = false }) {
  const year = currentYear();
  const propertyId = contract?.property_id || null;
  // The honest tenant count: resyncPropertyBilling rebuilds leases that already hold a
  // non-void annual invoice for the year, not every tenant on the property.
  const { data: billedTenants = 0 } = useQuery({
    queryKey: ['billedTenants', propertyId, year],
    queryFn: () => countBilledTenants(propertyId, year),
    enabled: !!propertyId && !isNew,
  });
  // The steps already on the contract — what the document's schedule replaces.
  const { data: existingSteps = [] } = useQuery({
    queryKey: ['contractEscalations', contract?.id],
    queryFn: () => listContractEscalations(contract.id),
    enabled: !!contract?.id,
  });

  const aiFlags = Array.isArray(extraction?.ai_review?.flags) ? extraction.ai_review.flags : [];
  const mismatches = Array.isArray(extraction?.extraction_mismatch) ? extraction.extraction_mismatch : [];
  const brief = typeof extraction?.analysis_brief === 'string' ? extraction.analysis_brief : '';
  const unknownBasis = Number(extraction?.fee_schedule_flag?.unknown_basis) || 0;

  // Priced through the SAME function the CAM sync uses, so what he reads here and what gets
  // written are one calculation, never two.
  const targets = contractTargets(contract, changes);
  const willBe = { ...contract, ...Object.fromEntries((changes?.fields || []).map((f) => [f.key, f.to])) };
  const camThisYear = contractAnnualCost(willBe, year, plan?.steps || null);
  const camNow = contractAnnualCost(contract, year, existingSteps);

  return (
    <>
      {aiFlags.length > 0 && (
        <div className="note-msg warn">
          <strong>⚑ The AI flagged {aiFlags.length} thing{aiFlags.length === 1 ? '' : 's'} in this contract</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {aiFlags.map((fl, i) => (
              <li key={fl.key || i}>{fl.title}{fl.note ? <span className="muted"> — {fl.note}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}
      {mismatches.length > 0 && (
        <p className="note-msg warn">
          ⚠ The AI’s notes say this contract carries <strong>{mismatchPhrase(mismatches)}</strong> that
          didn’t land on the figures below. Check {mismatches.length === 1 ? 'it' : 'those'} against
          the document before applying.
        </p>
      )}
      {unknownBasis > 0 && (
        <p className="note-msg warn">
          ⚠ <strong>{unknownBasis}</strong> row{unknownBasis === 1 ? '' : 's'} in the fee schedule
          {unknownBasis === 1 ? ' does' : ' do'} not say whether the figure is per month, per year or
          per visit. {unknownBasis === 1 ? 'It is' : 'They are'} left out rather than guessed — a
          per-visit rate read as a yearly one would land in CAM as a whole year’s cost.
        </p>
      )}
      {(changes?.unusableDates || []).map((u) => (
        <p className="note-msg warn" key={`u-${u.key}`}>
          ⚠ The <strong>{u.label.toLowerCase()}</strong> reads <strong>{u.printed}</strong>, which
          isn’t a real date on the calendar. It is left unchanged — everything else in this
          document still applies.
        </p>
      ))}
      {changes?.noticeDerived && (
        <p className="note-msg info">
          The contract states <strong>{changes.noticeDerived.days} days</strong> notice but prints no
          deadline, so Amlak works it out: <strong>{fmtDate(changes.noticeDerived.value)}</strong>,{' '}
          {changes.noticeDerived.days} days before {fmtDate(changes.noticeDerived.from)}. That is a
          calculated date, not one the document gives — check it before you rely on it.
        </p>
      )}

      {hasNoContractChanges(changes) ? (
        <p className="note-msg info">
          It states the same terms already on the contract, so there is nothing to update.
        </p>
      ) : (
        <>
          <p className="doc-choice-head">What changes on the contract</p>
          <table className="terms-diff">
            <thead>
              <tr><th>&nbsp;</th><th>Now</th><th>New contract</th></tr>
            </thead>
            <tbody>
              {(changes?.fields || []).map((f) => (
                <tr key={f.key} className={f.billed ? 'billed' : undefined}>
                  <th scope="row">{f.label}</th>
                  <td className="was">{show(f, f.from)}</td>
                  <td className="now">{show(f, f.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(changes?.fields || []).length && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              No stored figure changes — only the fee schedule below.
            </p>
          )}

          {/* The schedule itself, dated — not a count of it. A step is only real once it has
              a date, and showing the dates is what lets him check them against the document
              in front of him before any of it reaches CAM. */}
          {plan?.steps?.length > 0 && (
            <>
              <p className="doc-choice-head">The contract’s fee schedule</p>
              <table className="terms-diff schedule">
                <tbody>
                  {plan.steps.map((s) => (
                    <tr key={`s-${s.effective_date}`}>
                      <th scope="row">{fmtDate(s.effective_date)}</th>
                      <td className="now">
                        {money(s.new_amount)}
                        <span className="muted"> {FREQ_LABEL[targets.frequency] || 'per year'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {changes?.unusableSteps > 0 && (
            <p className="note-msg warn">
              ⚠ <strong>{changes.unusableSteps}</strong> row{changes.unusableSteps === 1 ? '' : 's'} in
              the document {changes.unusableSteps === 1 ? 'is' : 'are'} priced per visit or with no
              stated basis, so {changes.unusableSteps === 1 ? 'it' : 'they'} cannot be turned into a
              yearly cost. {changes.unusableSteps === 1 ? 'It is' : 'They are'} left out — add the real
              spend as an ordinary CAM line when the invoices arrive.
            </p>
          )}
          {changes?.undatedSteps > 0 && (
            <p className="note-msg warn">
              ⚠ <strong>{changes.undatedSteps}</strong> fee step
              {changes.undatedSteps === 1 ? '' : 's'} in the document {changes.undatedSteps === 1 ? 'has' : 'have'} no
              date the start date can place {changes.undatedSteps === 1 ? 'it' : 'them'} on, so
              {changes.undatedSteps === 1 ? ' it is' : ' they are'} not saved. Add{' '}
              {changes.undatedSteps === 1 ? 'it' : 'them'} by hand after applying.
            </p>
          )}

          <ul className="terms-extra">
            <li>
              This contract carries <strong>{money(camThisYear)}</strong> into {year}’s CAM
              {camNow > 0 && Math.abs(camNow - camThisYear) >= 0.005 && (
                <> — up from {money(camNow)}</>
              )}
              . The CAM line named <strong>{contract?.name || contract?.vendor || 'this contract'}</strong> is
              rebuilt at that figure; its name is not changed by the document.
            </li>
            {!isNew && (
              <li>
                <strong>{billedTenants || 'No'}</strong> tenant{billedTenants === 1 ? '' : 's'} at this
                property already {billedTenants === 1 ? 'has' : 'have'} a {year} bill, so{' '}
                {billedTenants === 1 ? 'it is' : 'those are'} rebuilt from the new CAM total. A year
                you have already closed is left exactly as it is.
              </li>
            )}
            {/* George, 2026-08-05: *"this only affects the ACTUAL CAM and Tax not estimated."*
                It is stated here in words because it is the difference between a tenant's bill
                moving today and moving at the year-end true-up, and nothing else on screen
                would tell him which. */}
            <li>
              Tenants on a <strong>CAM &amp; tax estimate</strong> are not touched — they keep paying
              their estimate and settle the difference at ⚖ Reconcile. Only tenants with no estimate
              are billed the new actual share now.
            </li>
            {plan?.steps?.length > 0 ? (
              <li>
                The document’s <strong>{plan.steps.length} fee step
                {plan.steps.length === 1 ? '' : 's'}</strong> replace every step on this contract
                {existingSteps.length > 0 && <> — including the {existingSteps.length} already on file,
                hand-added ones among them</>}.
              </li>
            ) : existingSteps.length > 0 ? (
              <li>
                This document prints no fee table, so the <strong>{existingSteps.length} fee step
                {existingSteps.length === 1 ? '' : 's'}</strong> already on the contract are left as
                they are — silence in a document is not an instruction to erase them.
              </li>
            ) : null}
            {targets.noticeByDate && (
              <li>
                Written notice to cancel falls due <strong>{fmtDate(targets.noticeByDate)}</strong>, and
                a reminder is armed for it.
                {willBe.auto_renew === true && <> If it is missed, the contract renews itself
                {willBe.renewal_term_months ? ` for a further ${willBe.renewal_term_months} months` : ''}.</>}
              </li>
            )}
            {targets.frequency === 'one-time' && (
              <li>
                This is a <strong>one-time</strong> fee, so it lands only in{' '}
                {targets.startDate ? new Date(`${targets.startDate}T12:00:00`).getFullYear() : 'its start year'} and
                never recurs into a later year’s CAM.
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
    </>
  );
}
