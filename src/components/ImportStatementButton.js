import { useRef, useState } from 'react';
import { uploadDoc, extractBankStatement } from '../lib/api';
import { parseBankStatementCsv, normalizeStatementRows, applyBalanceCheck } from '../lib/statementParse';
import { DEMO_MODE } from '../lib/supabaseClient';
import { money } from '../lib/format';
import { completenessSentence } from '../lib/dispositions';
import { useFileDrop } from './FileDrop';

// The two forms a bank hands you a statement in. Enforced here rather than left to
// the file input's `accept` (which browsers treat as a filter, not a rule) so the
// button and the drop zone refuse the same things — a dropped .docx would otherwise
// upload and spend an AI read before failing.
const STATEMENT_FILE = /\.(csv|pdf)$/i;

// Reading a statement file — the ONE pipeline, shared by both doors (the button and
// the drop zone) so what you get by dropping is what you get by clicking. Resolves to
// the payload each host hands to StatementReview, plus an optional `saveWarning` for
// the one failure that shouldn't stop an import. Throws on anything unreadable.
export async function readStatementFile(file) {
  if (!STATEMENT_FILE.test(file?.name || '')) {
    throw new Error(`“${file?.name || 'That file'}” isn’t a bank statement. Export the month as CSV from your bank, or use the PDF statement itself.`);
  }
  if (/\.csv$/i.test(file.name)) {
    // CSV lane — parsed right here, $0, no AI. The file itself is still kept: the
    // ledger should be able to show you the statement a figure came from, and a
    // CSV is a few KB. Best-effort — a storage hiccup must never block the import.
    const parsed = parseBankStatementCsv(await file.text(), { fileName: file.name });
    // Until migration 0070 this ALWAYS failed and the catch swallowed it: 'csv' was
    // in neither the client allowlist nor the bucket's, so validateUploadFile threw
    // and every CSV statement was silently discarded despite the comment above.
    let saveWarning = '';
    const path = await uploadDoc(file, { entityType: 'statement_import' }).catch((e) => {
      saveWarning = `Imported fine, but the statement file couldn’t be saved (${e.message || e}).`;
      return null;
    });
    return { fileName: file.name, accountHint: parsed.accountHint, parsed, storagePath: path, pdfLane: false, saveWarning };
  }
  // PDF lane — one transcription read (~5–15¢); the transcript still passes
  // the same validation gate + balance check the CSV lane gets.
  const path = await uploadDoc(file, { entityType: 'statement_import' });
  const res = await extractBankStatement({ path });
  // Statement lines are frequently dated "06/01" with the year stated once in
  // the period header — pass the period so the gate can resolve them instead
  // of skipping every line for "no valid date".
  const gate = normalizeStatementRows(res?.transactions || [], {
    periodStart: res?.period_start || null,
    periodEnd: res?.period_end || null,
  });
  const checked = applyBalanceCheck(gate.transactions);
  return {
    fileName: file.name,
    accountHint: null,
    parsed: { transactions: checked.transactions, skippedLines: gate.skippedLines, warnings: checked.warnings },
    storagePath: path,
    pdfLane: true,
    saveWarning: '',
  };
}

// The statement-import entry point, shared by the Ledger tab and the Financials
// page's Expense entry — two doors, one pipeline. Reads the file (CSV parsed right
// here, $0, never uploaded; PDF through one transcription read ~5–15¢) and hands
// the parsed lines to the caller via onReady({ fileName, accountHint, parsed,
// pdfLane }); the caller renders StatementReview. In demo mode a "Try a sample
// statement" button runs the bundled sample through the REAL gate + matcher.
export default function ImportStatementButton({ onReady }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function openStatementFile(file) {
    setErr('');
    setBusy(true);
    try {
      const ready = await readStatementFile(file);
      if (ready.saveWarning) setErr(ready.saveWarning);
      onReady(ready);
    } catch (e) {
      setErr(e?.message || 'Could not read that statement.');
    } finally {
      setBusy(false);
    }
  }

  async function openSampleStatement() {
    // Demo: the canned transcription runs the REAL gate + matcher — no AI, no files.
    setErr('');
    setBusy(true);
    try {
      const res = await extractBankStatement({ path: 'demo-sample' });
      const gate = normalizeStatementRows(res?.transactions || [], {
        periodStart: res?.period_start || null,
        periodEnd: res?.period_end || null,
      });
      onReady({
        fileName: 'sample-statement.pdf',
        accountHint: '••4821',
        parsed: { transactions: gate.transactions, skippedLines: gate.skippedLines, warnings: [] },
        pdfLane: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {DEMO_MODE && (
        <button type="button" className="secondary btn-sm" disabled={busy} onClick={openSampleStatement} title="Run the bundled sample statement through the real import flow — no files needed">
          Try a sample statement
        </button>
      )}
      <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()} title="Import a bank statement — CSV reads instantly and free; a PDF uses one AI transcription read (~5–15¢). You can also drag the file straight onto this panel.">
        {busy ? 'Reading…' : '⬆ Import statement'}
      </button>
      <input ref={fileRef} type="file" accept=".csv,.pdf" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openStatementFile(f); }} />
      {err && <span className="note-msg danger">{err}</span>}
    </>
  );
}

// Drag a statement straight onto the panel that carries the import button.
//
// George, 2026-07-30: "make the import statements on the ledger able to recieve a
// drag and drop."
//
// Nothing is drawn at rest — a permanent dashed box would cost real height on two
// screens that are already dense, and there is nothing to look at until a file is
// actually over the page. The target announces itself at the only moment it matters.
// The button stays exactly as it was: dragging is a second door, not a replacement.
export function StatementDropZone({ onReady, className = '', children }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  async function take(f) {
    setErr('');
    setName(f.name);
    setBusy(true);
    try {
      const ready = await readStatementFile(f);
      if (ready.saveWarning) setErr(ready.saveWarning);
      onReady(ready);
    } catch (ex) {
      setErr(ex?.message || 'Could not read that statement.');
    } finally {
      setBusy(false);
    }
  }

  // The drag state itself is the shared one (FileDrop.js) — the enter/leave depth count
  // that stops the veil flickering as the cursor crosses table rows was written here first
  // and lived in two files for a day. One implementation, per CLAUDE.md §3.
  //
  // ⚠ `accept` IS DELIBERATELY EMPTY. readStatementFile is the gate the BUTTON uses, and it
  // refuses a non-statement by name and explains what a statement is; a generic extension
  // check upstream of it would answer the same question worse, and differently from the
  // other door into the same feature.
  const { over, err: dropErr, dropProps } = useFileDrop({
    onFile: take,
    busy,
    // One statement at a time — each is reviewed and posted on its own, and silently
    // reading the first of five would look like the other four had been imported too.
    manyMessage: (n) => `${n} files were dropped — import one statement at a time.`,
  });

  return (
    // Takes the host's own class (the panel) rather than nesting inside it — one
    // element, so the veil covers exactly the panel it belongs to.
    <div className={`stmt-drop ${className}`.trim()} {...dropProps}>
      {children}
      {(over || busy) && (
        // pointer-events:none in the CSS — the veil must never become the drag target
        // itself, or entering it would read as leaving the panel and the count would lie.
        <div className="stmt-drop-veil" aria-hidden="true">
          <strong>{busy ? `Reading ${name}…` : 'Drop to import this statement'}</strong>
          <span>{busy ? 'One moment.' : 'CSV or PDF — it opens for you to review before anything is recorded.'}</span>
        </div>
      )}
      {(err || dropErr) && <p className="note-msg danger" style={{ marginTop: 10 }}>{err || dropErr}</p>}
    </div>
  );
}

// A statement import can touch OTHER properties' tenants (cross-property deposits)
// plus the target property's expenses — refresh every surface that money moved.
// Shared by both hosts so their invalidation sets can never drift apart.
export function settleStatementImport(qc) {
  qc.invalidateQueries({ queryKey: ['propertyRentRoll'] });
  qc.invalidateQueries({ queryKey: ['monthlyRent'] });
  qc.invalidateQueries({ queryKey: ['invoices'] });
  qc.invalidateQueries({ queryKey: ['payments'] });
  qc.invalidateQueries({ queryKey: ['invoicesForProperty'] });
  qc.invalidateQueries({ queryKey: ['tenantShares'] });
  qc.invalidateQueries({ queryKey: ['propertyTotals'] });
  qc.invalidateQueries({ queryKey: ['expenseRecord'] });
  qc.invalidateQueries({ queryKey: ['camLineItems'] });
  qc.invalidateQueries({ queryKey: ['taxLineItems'] });
  qc.invalidateQueries({ queryKey: ['corpRollups'] });
  // The Overview's "so far this year" bars — an import books both halves of them at
  // once: tenant deposits (collected) and dated expense lines (paid).
  qc.invalidateQueries({ queryKey: ['portfolioCollected'] });
  // …and the projected-vs-live band, which an import moves on BOTH sides for the same
  // reason: deposits are its live revenue, and an imported expense line is the only kind
  // that always arrives with a payment date, which is what its live expense figure counts.
  qc.invalidateQueries({ queryKey: ['portfolioBasis'] });
  qc.invalidateQueries({ queryKey: ['historyEvents'] });
  qc.invalidateQueries({ queryKey: ['statementImports'] });
  qc.invalidateQueries({ queryKey: ['statementContext'] });
  // An import records every line it read, and an undo takes them away with it (0076
  // cascades) — so the "money not yet placed" panel moves in both directions.
  qc.invalidateQueries({ queryKey: ['unplacedLines'] });
  // …and the panel that reads those same lines back: what was DECIDED. An import is the
  // only event that creates lines from nothing, so leaving it stale shows a record of a
  // statement that is no longer the whole story.
  qc.invalidateQueries({ queryKey: ['decidedLines'] });
  // An import can book an owner distribution, and undo takes it away again. Since the
  // entity ledger was retired (2026-08-12) that lands as a NOT-BILLED cam_line_items row
  // plus the bucket record carrying its `distribution` category — so both of those keys
  // move, and so does the corp-card roll-up derived from them. It still rides this set
  // rather than settleBillingChange's for the original reason: `billable = false` keeps
  // it out of cam_total, so no billed figure moved.
  qc.invalidateQueries({ queryKey: ['expenseBuckets'] });
  qc.invalidateQueries({ queryKey: ['corpDistributions'] });
  // Slice 4c — the same for money IN that isn't rent. `depositLines` is the lease
  // page's half of the deposit cross-check, so it has to move when an import records
  // one (and back again on undo).
  qc.invalidateQueries({ queryKey: ['otherIncome'] });
  qc.invalidateQueries({ queryKey: ['depositLines'] });
  qc.invalidateQueries({ queryKey: ['reconciliations'] });
  // An import auto-learns payee rules (and undo un-learns them) — refresh the manager.
  qc.invalidateQueries({ queryKey: ['importRules'] });
  // An import can set a tenant's CAM & tax estimate (read from a deposit), which lives
  // on the lease row itself — refresh the lease-terms page + Leases list.
  qc.invalidateQueries({ queryKey: ['leases'] });
  qc.invalidateQueries({ queryKey: ['lease'] });
}

// The post-save results strip: totals + cross-property note + ↩ Undo.
// imported = { summary, import, fileName } (applyStatementImport's result).
export function ImportResultsStrip({ imported, onUndo, undoPending, onDismiss }) {
  if (!imported) return null;
  const s = imported.summary;
  return (
    <div className="undo-strip" style={{ marginTop: 12 }}>
      <span>
        saved · Imported {imported.fileName} — {s.paymentsCount} payment{s.paymentsCount === 1 ? '' : 's'} · {money(s.paymentsTotal)} in
        {' · '}{s.expensesCount} expense{s.expensesCount === 1 ? '' : 's'} · {money(s.expensesTotal)} out
        {/* Slice 4c — stated APART from payments, never folded into them. A late fee
            counted as a payment would report rent collection that never happened. */}
        {s.incomeCount > 0 && <> · {s.incomeCount} other income · {money(s.incomeTotal)}</>}
        {s.depositCount > 0 && <> · {s.depositCount} security deposit{s.depositCount === 1 ? '' : 's'} · {money(s.depositTotal)} held</>}
        {Object.keys(s.crossProperty || {}).length > 0 && (
          <> · {Object.values(s.crossProperty).reduce((n, c) => n + c, 0)} payment(s) posted to other properties' tenants — they show on those ledgers</>
        )}
        {/* Slice 4a — the completeness statement, at the moment it reassures: every
            line the statement contained is now on record, whatever was decided about
            it. Only shown when the audit rows were actually written (an import from
            before 0076, or one whose audit write failed, states nothing rather than
            claiming a total it can't back). */}
        {s.completeness?.total > 0 && (
          <> · <strong>{completenessSentence(s.completeness)}</strong></>
        )}
      </span>
      <button type="button" className="ghost btn-sm" disabled={undoPending} onClick={onUndo}>↩ Undo</button>
      <button type="button" className="icon-btn" title="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}
