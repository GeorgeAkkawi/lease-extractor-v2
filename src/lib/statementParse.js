// Bank-statement CSV parsing — pure, deterministic, $0 (no AI anywhere in this
// lane). A CSV is already structured data; the only real work is surviving the
// mess banks export: junk preamble lines, BOM, quoted commas in descriptions,
// $-and-comma amounts, parentheses negatives, and EITHER one signed amount column
// OR a separate Debit/Credit pair.
//
// Honesty guarantees baked in:
//   • Nothing silently vanishes — every line that isn't imported lands in
//     `skippedLines` with its reason, and the review header shows "N parsed ·
//     M skipped".
//   • Balance self-check — when the export carries a running-balance column, each
//     row's balance delta must equal its signed amount; a mismatch flags the row
//     `needsReview` instead of silently mis-signing money. (A self-audit no model
//     can offer; it also runs on PDF-transcribed rows.)
//   • normalizeStatementRows is the ONE validation gate BOTH lanes (CSV + the PDF
//     edge-fn transcription) pass through before any matching — a malformed row
//     can never reach the matcher, whichever lane produced it.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// "$1,234.56" / "(1,234.56)" / "-1234.56" / "1 234,56"-free simple money → signed
// number, or null when it isn't money.
export function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/[$\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Plenty of statements (Chase among them) print each line as a bare "06/01" — the
// year is stated ONCE, in the period header. Given that period, work out which
// year a month/day belongs to: the one that lands inside it, so a statement
// straddling New Year splits 12/28 and 01/03 into their right years instead of
// stamping both with one.
export function yearForMonthDay(m, d, { periodStart = null, periodEnd = null, fallbackYear = null } = {}) {
  const start = periodStart ? toIsoDate(periodStart) : null;
  const end = periodEnd ? toIsoDate(periodEnd) : null;
  const cands = [];
  for (const y of [start && +start.slice(0, 4), end && +end.slice(0, 4), fallbackYear && +fallbackYear]) {
    if (y && y >= 1990 && y <= 2100 && !cands.includes(y)) cands.push(y);
  }
  if (!cands.length) return null;
  if (start && end) {
    for (const y of cands) {
      const iso = `${y}-${pad2(m)}-${pad2(d)}`;
      if (iso >= start && iso <= end) return y;
    }
  }
  // Outside the stated period (a pending line posted after the close) or no period
  // at all — the nearest candidate wins, so a January line on a December statement
  // doesn't jump a year backwards.
  const anchor = end || start;
  if (!anchor) return cands[0];
  const anchorMs = Date.parse(`${anchor}T12:00:00`);
  let best = cands[0];
  let bestGap = Infinity;
  for (const y of cands) {
    const gap = Math.abs(Date.parse(`${y}-${pad2(m)}-${pad2(d)}T12:00:00`) - anchorMs);
    if (gap < bestGap) { bestGap = gap; best = y; }
  }
  return best;
}

// "MM/DD/YYYY", "M/D/YY", "YYYY-MM-DD" → "YYYY-MM-DD", or null. US month-first
// (the bank-export norm here); ISO passes through. A year-less "MM/DD" resolves
// only when the caller passes a year context — with none we still return null
// rather than guess, which is what keeps the CSV lane's column inference from
// reading a stray "1/2" as a date.
export function toIsoDate(raw, yearCtx = null) {
  if (raw == null) return null;
  const s = String(raw).trim();
  let y, m, d;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) {
    m = +mt[1]; d = +mt[2]; y = +mt[3];
    if (y < 100) y += 2000;
  } else if ((mt = s.match(/^(\d{1,2})[/-](\d{1,2})$/))) {
    if (!yearCtx) return null;
    m = +mt[1]; d = +mt[2];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    y = yearForMonthDay(m, d, yearCtx);
    if (y == null) return null;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(y, m - 1, d, 12);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Split one CSV line on `delim`, honoring double quotes ("" = an escaped quote).
export function splitCsvLine(line, delim = ',') {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// The masked bank-account identifier ("••4821") from the preamble junk or the file
// name — powers the "Account ••4821 — last imported into {property}" memory.
export function accountHintFrom(preambleLines = [], fileName = '') {
  for (const line of preambleLines) {
    const m = String(line).match(/(?:account|acct)\D{0,12}(\d[\d\s-]{2,}\d)/i);
    if (m) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length >= 4) return `••${digits.slice(-4)}`;
    }
  }
  const f = String(fileName || '');
  const fm = f.match(/(?:account|acct)[_ -]?(\d{4,})/i) || f.match(/(\d{7,})/);
  if (fm) return `••${fm[1].slice(-4)}`;
  return null;
}

const DATE_HEADERS = ['posting date', 'post date', 'transaction date', 'date'];
const DESC_HEADERS = ['description', 'payee', 'memo', 'details', 'transaction', 'name'];
const AMOUNT_HEADERS = ['amount'];
const DEBIT_HEADERS = ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out'];
const CREDIT_HEADERS = ['credit', 'deposit', 'deposits', 'money in', 'paid in'];
const BALANCE_HEADERS = ['balance', 'running balance', 'running bal'];

const findCol = (headers, names) => {
  for (const name of names) {
    const i = headers.findIndex((h) => h === name);
    if (i !== -1) return i;
  }
  for (const name of names) {
    const i = headers.findIndex((h) => h.includes(name));
    if (i !== -1) return i;
  }
  return -1;
};

// Parse a whole bank-CSV export. Returns
//   { transactions, skippedLines, warnings, accountHint }
// transactions: { line, date, description, amount (>0), direction 'in'|'out',
//                 balance (number|null), needsReview? }
export function parseBankStatementCsv(text, { fileName = '' } = {}) {
  const warnings = [];
  const skippedLines = [];
  const clean = String(text || '').replace(/^﻿/, ''); // BOM
  const lines = clean.split(/\r\n|\r|\n/);

  // Delimiter: whichever of , ; \t splits the most lines into >2 cells.
  let delim = ',';
  let best = 0;
  for (const d of [',', ';', '\t']) {
    const score = lines.reduce((s, l) => s + (splitCsvLine(l, d).length > 2 ? 1 : 0), 0);
    if (score > best) { best = score; delim = d; }
  }

  // Header row: the first line naming both a date column and some amount column.
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delim).map((c) => c.toLowerCase());
    if (cells.length < 2) continue;
    const dateCol = findCol(cells, DATE_HEADERS);
    const amountCol = findCol(cells, AMOUNT_HEADERS);
    const debitCol = findCol(cells, DEBIT_HEADERS);
    const creditCol = findCol(cells, CREDIT_HEADERS);
    if (dateCol !== -1 && (amountCol !== -1 || debitCol !== -1 || creditCol !== -1)) {
      headerIdx = i;
      cols = {
        date: dateCol,
        desc: findCol(cells, DESC_HEADERS),
        amount: amountCol,
        debit: debitCol,
        credit: creditCol,
        balance: findCol(cells, BALANCE_HEADERS),
      };
      break;
    }
  }

  // No header → positional inference on the first data-looking line: date first,
  // then description, then the numeric columns (amount, then balance if a 2nd).
  if (headerIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i], delim);
      if (cells.length >= 3 && toIsoDate(cells[0])) {
        const numeric = [];
        for (let c = 1; c < cells.length; c++) if (parseMoney(cells[c]) != null && !toIsoDate(cells[c])) numeric.push(c);
        if (numeric.length >= 1) {
          headerIdx = i - 1; // rows start at i
          cols = {
            date: 0,
            desc: [...cells.keys()].find((c) => c > 0 && !numeric.includes(c) && !toIsoDate(cells[c])) ?? 1,
            amount: numeric[0],
            debit: -1,
            credit: -1,
            balance: numeric.length > 1 ? numeric[numeric.length - 1] : -1,
          };
          warnings.push('No header row found — columns were inferred from the data (date · description · amount).');
          break;
        }
      }
    }
  }

  if (headerIdx === -1 || !cols) {
    return { transactions: [], skippedLines: [], warnings: ['Could not find any transaction rows in this file — is it a bank CSV export?'], accountHint: accountHintFrom(lines.slice(0, 10), fileName) };
  }

  const accountHint = accountHintFrom(lines.slice(0, Math.max(0, headerIdx)), fileName);

  const transactions = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = splitCsvLine(raw, delim);
    const date = toIsoDate(cells[cols.date]);
    if (!date) { skippedLines.push({ line: i + 1, raw, reason: 'no valid date' }); continue; }
    const description = cols.desc !== -1 ? (cells[cols.desc] || '') : '';

    let signed = null;
    if (cols.amount !== -1) {
      signed = parseMoney(cells[cols.amount]);
    }
    if (signed == null && (cols.debit !== -1 || cols.credit !== -1)) {
      const debit = cols.debit !== -1 ? parseMoney(cells[cols.debit]) : null;
      const credit = cols.credit !== -1 ? parseMoney(cells[cols.credit]) : null;
      if (debit != null && debit !== 0) signed = -Math.abs(debit);
      else if (credit != null && credit !== 0) signed = Math.abs(credit);
    }
    if (signed == null || signed === 0) { skippedLines.push({ line: i + 1, raw, reason: 'no amount' }); continue; }

    const balance = cols.balance !== -1 ? parseMoney(cells[cols.balance]) : null;
    transactions.push({
      line: i + 1,
      date,
      description,
      amount: round2(Math.abs(signed)),
      direction: signed > 0 ? 'in' : 'out',
      balance,
    });
  }

  const checked = applyBalanceCheck(transactions);
  warnings.push(...checked.warnings);
  return { transactions: checked.transactions, skippedLines, warnings, accountHint };
}

// The running-balance self-check, shared by both lanes: between consecutive rows
// that carry a balance, the delta must equal the row's signed amount (±1¢).
// Statements come newest-first or oldest-first — both orientations are tried and
// the better fit wins. Mismatching rows get `needsReview: true` and one warning
// summarizes; with no balance column this is a no-op.
export function applyBalanceCheck(transactions) {
  const rows = transactions.map((t) => ({ ...t }));
  const withBal = rows.filter((t) => t.balance != null && Number.isFinite(Number(t.balance)));
  if (withBal.length < 2) return { transactions: rows, warnings: [] };

  const signed = (t) => (t.direction === 'in' ? t.amount : -t.amount);
  // oldest-first: balance[i] − balance[i-1] === signed[i]
  // newest-first: balance[i-1] − balance[i] === signed[i-1]
  const misOldest = [];
  const misNewest = [];
  for (let i = 1; i < withBal.length; i++) {
    const prev = withBal[i - 1];
    const cur = withBal[i];
    if (Math.abs(round2(Number(cur.balance) - Number(prev.balance)) - round2(signed(cur))) > 0.011) misOldest.push(cur);
    if (Math.abs(round2(Number(prev.balance) - Number(cur.balance)) - round2(signed(prev))) > 0.011) misNewest.push(prev);
  }
  const mismatches = misOldest.length <= misNewest.length ? misOldest : misNewest;
  if (mismatches.length) {
    const lines = new Set(mismatches.map((t) => t.line));
    for (const t of rows) if (lines.has(t.line)) t.needsReview = true;
    return {
      transactions: rows,
      warnings: [`Balance check: ${mismatches.length} line${mismatches.length === 1 ? "'s" : 's'} amount doesn't match the running balance — flagged for review (a mis-signed or missing line upstream can cause this).`],
    };
  }
  return { transactions: rows, warnings: [] };
}

// The shared validation gate BOTH lanes pass through before the matcher. Accepts
// loosely-shaped rows (the PDF lane's model output is strings) and returns only
// structurally-sound transactions; everything else is skipped WITH its reason.
export function normalizeStatementRows(rowsIn, { periodStart = null, periodEnd = null } = {}) {
  const rows = rowsIn || [];
  // Year context for lines printed as a bare "06/01": the statement's own period
  // when the read captured it, plus the year the fully-dated lines agree on (a
  // statement that dates even one line in full tells us its year for free).
  const yearCtx = { periodStart, periodEnd, fallbackYear: commonYearIn(rows) };
  const hasCtx = Boolean(yearCtx.periodStart || yearCtx.periodEnd || yearCtx.fallbackYear);
  const transactions = [];
  const skippedLines = [];
  rows.forEach((r, idx) => {
    const line = r?.line ?? idx + 1;
    const shown = describeRow(r);
    const date = toIsoDate(r?.date, hasCtx ? yearCtx : null);
    if (!date) { skippedLines.push({ line, raw: shown, reason: dateSkipReason(r?.date) }); return; }
    const amount = typeof r?.amount === 'number' ? r.amount : parseMoney(r?.amount);
    if (amount == null || !(Math.abs(amount) > 0)) { skippedLines.push({ line, raw: shown, reason: 'no amount' }); return; }
    const direction = r?.direction === 'in' || r?.direction === 'out' ? r.direction : amount < 0 ? 'out' : null;
    if (!direction) { skippedLines.push({ line, raw: shown, reason: 'no direction (in/out)' }); return; }
    const balance = r?.balance == null || r.balance === '' ? null : typeof r.balance === 'number' ? r.balance : parseMoney(r.balance);
    transactions.push({
      line,
      date,
      description: String(r?.description ?? '').trim(),
      amount: round2(Math.abs(amount)),
      direction,
      balance,
      ...(r?.needsReview ? { needsReview: true } : {}),
    });
  });
  return { transactions, skippedLines };
}

// The year the fully-dated rows agree on — the free fallback when a statement
// prints most lines bare but dates at least one in full. Most common wins.
function commonYearIn(rows) {
  const tally = new Map();
  for (const r of rows) {
    const iso = toIsoDate(r?.date);
    if (iso) tally.set(iso.slice(0, 4), (tally.get(iso.slice(0, 4)) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [y, n] of tally) if (n > bestN) { bestN = n; best = +y; }
  return best;
}

// A skipped line is only honest if it says what was wrong with THIS line — a
// dumped JSON blob doesn't tell a landlord anything.
function dateSkipReason(raw) {
  const s = String(raw ?? '').trim();
  if (s && /^\d{1,2}[/-]\d{1,2}$/.test(s)) return `the date "${s}" has no year, and the statement period wasn't captured`;
  return s ? `no valid date ("${s}")` : 'no date';
}

function describeRow(r) {
  return [r?.date, r?.description, r?.amount].map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ');
}
