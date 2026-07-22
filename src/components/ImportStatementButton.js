import { useRef, useState } from 'react';
import { uploadDoc, extractBankStatement } from '../lib/api';
import { parseBankStatementCsv, normalizeStatementRows, applyBalanceCheck } from '../lib/statementParse';
import { DEMO_MODE } from '../lib/supabaseClient';
import { money } from '../lib/format';

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
      if (/\.csv$/i.test(file.name)) {
        // CSV lane — parsed right here, $0, never uploaded.
        const parsed = parseBankStatementCsv(await file.text(), { fileName: file.name });
        onReady({ fileName: file.name, accountHint: parsed.accountHint, parsed, pdfLane: false });
      } else {
        // PDF lane — one transcription read (~5–15¢); the transcript still passes
        // the same validation gate + balance check the CSV lane gets.
        const path = await uploadDoc(file);
        const res = await extractBankStatement({ path });
        const gate = normalizeStatementRows(res?.transactions || []);
        const checked = applyBalanceCheck(gate.transactions);
        onReady({
          fileName: file.name,
          accountHint: null,
          parsed: { transactions: checked.transactions, skippedLines: gate.skippedLines, warnings: checked.warnings },
          pdfLane: true,
        });
      }
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
      const gate = normalizeStatementRows(res?.transactions || []);
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
      <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()} title="Import a bank statement — CSV reads instantly and free; a PDF uses one AI transcription read (~5–15¢)">
        {busy ? 'Reading…' : '⬆ Import statement'}
      </button>
      <input ref={fileRef} type="file" accept=".csv,.pdf" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openStatementFile(f); }} />
      {err && <span className="note-msg danger">{err}</span>}
    </>
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
  qc.invalidateQueries({ queryKey: ['corpRollups'] });
  qc.invalidateQueries({ queryKey: ['historyEvents'] });
  qc.invalidateQueries({ queryKey: ['statementImports'] });
  qc.invalidateQueries({ queryKey: ['statementContext'] });
  qc.invalidateQueries({ queryKey: ['reconciliations'] });
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
        {Object.keys(s.crossProperty || {}).length > 0 && (
          <> · {Object.values(s.crossProperty).reduce((n, c) => n + c, 0)} payment(s) posted to other properties' tenants — they show on those ledgers</>
        )}
      </span>
      <button type="button" className="ghost btn-sm" disabled={undoPending} onClick={onUndo}>↩ Undo</button>
      <button type="button" className="icon-btn" title="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}
