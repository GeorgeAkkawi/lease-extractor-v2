// Statement-line matching — pure, deterministic, $0. Every function here only
// SUGGESTS: the review screen shows each pick as an option and nothing writes
// until the user saves. Money math and classification never run in a model.
//
// Matching order per line (first hit wins):
//   0. The line's fiscal year comes from ITS OWN date — never the page's FY
//      selector — so a statement spanning Dec/Jan books each line into the right
//      year.
//   1. Duplicate guard: lineHash vs the owner's LIVE payments.import_hash set
//      (+ prior imports' applied expenses) → greyed "already imported", skipped
//      by default but overridable ("import anyway").
//   2. Rules — the payee memory: first property-scoped, direction-compatible rule
//      whose pattern is contained in the normalized description → auto-confirmed.
//   3. Deposits: tenant-name token fuzzy across ALL the owner's properties,
//      corroborated by amount (one month's billed charge, the earliest gap, k
//      consecutive uncovered months, the invoice total, or an open reconciliation
//      balance — a true-up check matches its true-up and carries NO month tag).
//   4. Withdrawals: keyword table (tax/roof/CAM kinds; mortgage/transfer → ignore
//      with the reason shown). Unknown money-out is NEVER auto-booked.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DUST = 0.05;

// Uppercase, strip punctuation, collapse whitespace — the canonical description
// both the hash and every pattern/name comparison use.
export function normalizeDesc(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic line identity for the duplicate guard: date|amount|direction|desc.
// djb2 over the canonical string, hex — stable across sessions and imports.
export function lineHash(txn) {
  const key = `${txn.date}|${round2(txn.amount).toFixed(2)}|${txn.direction}|${normalizeDesc(txn.description)}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `v1-${h.toString(16)}-${key.length}`;
}

// Corporate noise words that carry no identity ("D & D Dental, LLC" → D D DENTAL).
const NOISE = new Set(['LLC', 'INC', 'CO', 'CORP', 'LLP', 'LP', 'LTD', 'THE', 'OF', 'AND', 'A', 'GROUP', 'COMPANY']);

export function significantTokens(name) {
  return normalizeDesc(name)
    .split(' ')
    .filter((t) => t && !NOISE.has(t) && !(t.length === 1 && !/\d/.test(t)));
}

// Fraction of the tenant's significant name tokens present in the description
// (0..1). "CHECK 1044 CITY DENTAL PC" vs "City Dental" → 1.
export function tenantNameScore(description, tenantName) {
  const tokens = significantTokens(tenantName);
  if (!tokens.length) return 0;
  const desc = ` ${normalizeDesc(description)} `;
  let hits = 0;
  for (const t of tokens) if (desc.includes(` ${t} `)) hits++;
  return hits / tokens.length;
}

// ±$1 or ±1%, whichever is larger — checks land near, not on, the billed figure.
export function amountMatches(a, b) {
  if (!(b > 0)) return false;
  return Math.abs(a - b) <= Math.max(1, 0.01 * b);
}

// Wording that names the payment RAIL, not the payee — it appears on every ACH /
// wire / card / check line whoever sent the money. A noise token BREAKS a run exactly
// like a digit does; it is never spliced out, because splicing would fuse two separate
// runs into a phrase that matches neither line next month.
//   "Online ACH Debit 9031521835 From Gustavo" → GUSTAVO (was "ONLINE ACH DEBIT",
//   which every one of the landlord's ACH tenants also matched — so one rule
//   swallowed six payees, last one saved wins).
// Second round (2026-07-31, U.S. Bank): every bank writes its own rail vocabulary, and
// this list only knew Chase's. "Electronic Withdrawal To WASTE MANAGEMENT" and "Debit
// Purchase - VISA CITY OF*NAPERVIL On 012926" both hid the payee behind wording nothing
// here broke on. `ON` earns its place because "On <date>" trails every card line — the
// 3-character floor keeps it from ever being a pattern in its own right.
const BANK_NOISE = new Set([
  'ORIG', 'CO', 'NAME', 'ID', 'DESC', 'DATE', 'ENTRY', 'DESCR', 'ACH', 'SEC',
  'CCD', 'PPD', 'WEB', 'TEL', 'TRACE', 'ONLINE', 'DEBIT', 'CREDIT', 'FROM', 'TO',
  'PMT', 'PAYMENT', 'PAYMENTS', 'DEPOSIT', 'DEPOSITS', 'TRANSFER', 'CHECK',
  'MOBILE', 'BANKING', 'EFT', 'XFER', 'REF', 'INDN', 'BANK', 'ACCT', 'ACCOUNT',
  // U.S. Bank's wording, and the card/bill-pay rails generally.
  'ELECTRONIC', 'WITHDRAWAL', 'WITHDRAWALS', 'PURCHASE', 'PURCHASES', 'PURCH',
  'VISA', 'MASTERCARD', 'AMEX', 'POS', 'ATM', 'CARD', 'WIRE', 'ON',
  'CHECKS', 'PRESENTED', 'CONVENTIONALLY', 'BUSINESS', 'BILL', 'PAY', 'ESS',
  'PMTID', 'AUTOPAY', 'RECURRING', 'TRN', 'TRAN',
]);

// Every CONTIGUOUS run of tokens that are neither digits nor rail wording. Contiguous
// because matching is a plain `contains`, and check/reference numbers change every month
// ("CHECK 1044 CITY DENTAL PC" → "CITY DENTAL PC" still matches CHECK 1045).
function payeeRuns(description) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur.join(' ')); cur = []; };
  for (const t of normalizeDesc(description).split(' ')) {
    if (!t || /\d/.test(t) || BANK_NOISE.has(t)) flush();
    else cur.push(t);
  }
  flush();
  return out.filter((r) => r.length >= 3);
}

// The "always match {payee}" pattern suggested from one statement line. When only
// boilerplate survives, learn NOTHING (null) rather than a pattern that would match
// every line on next month's statement.
//
// `siblings` — every description on the SAME statement. This is the guarantee that does
// NOT depend on the word list above, and it exists because the list has now been the bug
// twice, one bank apart: the rail is what the statement's lines have in COMMON, and the
// payee is what only its own line says. So the run present on the fewest lines wins, and
// length only breaks a tie. A 1-arg call (no statement to compare against) keeps the
// original longest-run behaviour exactly.
export function suggestRulePattern(description, siblings = []) {
  const runs = payeeRuns(description);
  if (!runs.length) return null;
  const others = (siblings || []).map((s) => normalizeDesc(s));
  const hits = (run) => (others.length ? others.filter((d) => d.includes(run)).length : 0);
  let best = null;
  let bestHits = Infinity;
  for (const run of runs) {
    const h = hits(run);
    if (h < bestHits || (h === bestHits && run.length > (best?.length || 0))) { best = run; bestHits = h; }
  }
  return best;
}

// The guarantee that doesn't depend on the word list above: a pattern is only a
// PAYEE if it can tell this statement's own payees apart. A stopword list makes a
// good pattern likely; this makes a bad one impossible, for any bank's wording.
//   candidates — [{ pattern, targetKey, ... }] the rules we'd like to learn
//   lines      — [{ description, targetKey }] every line in the SAME statement that
//                resolves to something (targetKey identifies the tenant/bucket)
//   ownNames   — the landlord's OWN corporation names. A bank names the account holder
//                on its own transfer lines, so a pattern that says "NASA Property LLC"
//                is naming the landlord, not a payee — George's real statement learned
//                exactly that as "always match → Ricki's-Lyons". One statement can't see
//                the conflict (only one line carried it), so the screen needs telling.
// A candidate whose pattern also appears on a line resolving to a DIFFERENT target
// is boilerplate: learning it would point all of those lines at whichever saved
// last. Reject it (and say so), keep the rest.
// The destinations for which naming the owner's own corporation is CORRECT rather
// than a mis-learned payee — see the guard inside screenRulePatterns.
const OWN_NAME_TARGETS = new Set(['transfer', 'owner_draw', 'owner_contribution', 'entity_cost']);

export function screenRulePatterns(candidates = [], lines = [], ownNames = []) {
  const norm = (lines || []).map((l) => ({ desc: normalizeDesc(l?.description), targetKey: l?.targetKey || null }));
  const own = (ownNames || []).map((n) => normalizeDesc(n)).filter((n) => n.length >= 3);
  const keep = [];
  const rejected = new Map();
  for (const c of candidates || []) {
    const pat = normalizeDesc(c?.pattern);
    if (pat.length < 3) continue;
    const hits = norm.filter((l) => l.desc.includes(pat));
    const conflicts = hits.filter((l) => l.targetKey && l.targetKey !== c.targetKey);
    // Slice 4b scopes this guard rather than dropping it. A pattern naming the
    // landlord's own corporation is still nonsense as a TENANT or a VENDOR — that is
    // the "NASA PROPERTY LLC TRN → always match Ricki's-Lyons" rule that prompted it.
    // But the reason the bank prints the account holder's name is that the line IS a
    // transfer or a draw, so pointing it at one of those is not a mistake, it is the
    // correct answer — and refusing to learn it would mean re-picking the same
    // distribution by hand every month forever.
    const isOwn = own.some((n) => pat.includes(n) || n.includes(pat)) && !OWN_NAME_TARGETS.has(c.targetKey);
    if (conflicts.length || isOwn) {
      if (!rejected.has(pat)) rejected.set(pat, { pattern: c.pattern, count: hits.length, own: isOwn });
    } else {
      keep.push(c);
    }
  }
  return { keep, rejected: [...rejected.values()] };
}

// ---- Withdrawal keyword table ------------------------------------------------
const CAM_KEYWORDS = [
  ['LANDSCAP', 'Landscaping'],
  ['SNOW', 'Snow removal'],
  ['JANITOR', 'Janitorial'],
  ['HVAC', 'HVAC service'],
  ['UTILIT', 'Utilities'],
  ['ELECTRIC', 'Electric'],
  ['WATER', 'Water'],
  ['SEWER', 'Sewer'],
  ['TRASH', 'Trash removal'],
  ['WASTE', 'Waste removal'],
  ['SECURITY', 'Security'],
  ['PLUMB', 'Plumbing'],
  ['PEST', 'Pest control'],
  ['CLEAN', 'Cleaning'],
  ['MAINT', 'Maintenance'],
  ['ELEVATOR', 'Elevator service'],
  ['PAVING', 'Paving'],
  ['PARKING', 'Parking lot'],
];
// Money OUT that is real but is not this building's operating expense.
//
// ⚠ THESE MATCH ON WORD BOUNDARIES, NOT SUBSTRINGS, AND THAT IS A CORRECTNESS FIX.
// This table used to read `desc.includes('DRAW')`, so "Electronic Withdrawal To WASTE
// MANAGEMENT" — how U.S. Bank writes EVERY withdrawal, and 401 S Main's statements
// are U.S. Bank — classified as an owner draw with HIGH confidence. While the answer
// was merely `ignore` that was an unhelpful suggestion; now that a draw is a real
// destination that writes a real row, the same false positive would file a Comcast
// bill as a distribution. `LOAN` had the same shape (it matches the surname "Sloan").
// The CAM keywords below stay substrings on purpose — they are stems (LANDSCAP →
// LANDSCAPING) — but a whole word must be matched as a whole word.
//
// MORTGAGE and LOAN stay `ignore`: debt is Slice 6 and Amlak genuinely has nowhere to
// put them yet. Saying so in the reason is more honest than inventing a home.
const OUT_KEYWORDS = [
  [/(^| )DRAWS?( |$)/, { kind: 'owner_draw', reason: 'looks like money you took out — recorded as equity, never as an expense' }],
  [/(^| )DISTRIBUTIONS?( |$)/, { kind: 'owner_draw', reason: 'looks like an owner distribution — recorded as equity, never as an expense' }],
  [/TRANSFER/, { kind: 'transfer', reason: 'looks like a transfer between your own accounts — neither income nor expense' }],
  [/(^| )MORTGAGE/, { kind: 'ignore', reason: 'a mortgage payment is not a recoverable CAM expense — Amlak has no home for debt yet' }],
  [/(^| )LOANS?( |$)/, { kind: 'ignore', reason: 'loan payments are not operating expenses — Amlak has no home for debt yet' }],
];

// The built-in bucket names the review dropdown offers alongside the owner's own
// buckets (every keyword hit is a billable CAM bucket).
export const CAM_KEYWORD_LABELS = CAM_KEYWORDS.map(([, label]) => label);

// Classify one money-OUT line. Returns { kind, label?, reason?, confidence }.
// Unknown money-out → suggest ignore (never auto-booked).
export function classifyWithdrawal(description, tenants = []) {
  const desc = normalizeDesc(description);
  for (const [re, out] of OUT_KEYWORDS) {
    // Suggested, never auto-ticked: money out is not booked without the landlord's
    // say-so, and an untouched suggestion stays UNPLACED and keeps nagging rather
    // than posing as a decision they made (the round-6 judgement, carried forward).
    if (re.test(desc)) return { ...out, confidence: 'high' };
  }
  if (/(^| )(TAX|TAXES|COUNTY|TREASURER|ASSESSOR)( |$)/.test(desc)) {
    return { kind: 'expense_tax', confidence: 'high' };
  }
  if (desc.includes('ROOF')) return { kind: 'expense_roof', confidence: 'high' };
  for (const [kw, label] of CAM_KEYWORDS) {
    if (desc.includes(kw)) return { kind: 'expense_cam', label, confidence: 'high' };
  }
  // Money OUT to a tenant's name — likely a refund/credit paid to them; that flow
  // lives in the reconciliation "Mark refunded" action, not here.
  for (const t of tenants) {
    if (tenantNameScore(description, t.tenant_name) >= 0.99) {
      return { kind: 'ignore', reason: `looks like money paid TO ${t.tenant_name} — record refunds via the reconciliation's "Mark refunded"`, confidence: 'medium' };
    }
  }
  return { kind: 'ignore', reason: 'unrecognized — money out is never booked without your say-so', confidence: 'none' };
}

// ---- Deposit matching --------------------------------------------------------
// tenants: [{ lease_id, property_id, property_name, tenant_name, owed (12-array),
//             coverage (12-array), monthly, invoiceTotal, invoiceBalance,
//             reconInvoiceId?, reconBalance?, steps? }]
//   steps — escalationStepMonths' output [{ month, owed, base, prevBase }], each a
//           mid-year BASE step-up. Present so a deposit still at the pre-raise rate
//           for a post-step month reads as explained by the step, not "short".

// The latest step in effect at (or before) month m — null when none. Handles a
// twice-stepped year (returns the most recent applicable step).
export function stepAtOrBefore(steps, m) {
  if (!Array.isArray(steps) || !steps.length) return null;
  let best = null;
  for (const s of steps) {
    if (s && Number(s.month) <= m && (!best || Number(s.month) > Number(best.month))) best = s;
  }
  return best;
}

// The month's owed BEFORE a step took effect: the month's own owed minus the base
// delta the step added (CAM/tax/roof are unchanged by an escalation), so it holds
// for any post-step month and never disturbs the non-base components.
const preStepOwed = (owedM, s) => round2(owedM - round2(Number(s.base) - Number(s.prevBase)));

// The 1-12 month a statement line's own date falls in (null when unparseable).
export const monthOfDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? Number(String(iso).slice(5, 7)) : null);

// Amount corroboration against ONE tenant. Returns
//   { corroborated, month (1-12|null), toRecon, escalated? } — month null = untagged
//   (FIFO); escalated marks a match at the pre-raise rate on a post-step month.
//
// txnMonth (optional, 1-12) is the month the money LANDED, printed on the line, and
// when it's there it DECIDES the month — a statement is dated from its own lines
// (George, twice: "the months under the for month column should correspond with the
// date of the statement"). A landlord importing last May's statement is telling you
// what month it is; guessing a different one from what's still open is how nine of his
// deposits ended up settling months he never chose. Every 2-arg call is unchanged: with
// no date to go on, the earliest month the tenant still owes is still the best answer.
//
// A lump still wins over the line's own month — a check that pays several months, the
// whole year, or an open true-up is returned UNTAGGED so the ledger's pool spreads it.
// Tagging it to one month would settle that month and lose the rest.
//
// `corroborated` keeps its exact meaning: the amount matches what that month bills (or
// its remaining gap, or the pre-raise rate). An uncorroborated line still carries its
// month — it just doesn't auto-tick, so confidence and auto-ticking are untouched.
export function corroborateAmount(amount, t, txnMonth = null) {
  // An open reconciliation true-up: the check that settles it matches its balance.
  if (t.reconBalance > 0 && amountMatches(amount, t.reconBalance)) {
    return { corroborated: true, month: null, toRecon: true };
  }
  const tm = Number(txnMonth);
  const hasTxnMonth = tm >= 1 && tm <= 12;
  const owed = t.owed || [];
  const cov = t.coverage || [];
  const gaps = owed.map((o, i) => round2(Math.max(0, (Number(o) || 0) - (Number(cov[i]) || 0))));
  const firstOpen = gaps.findIndex((g) => g > DUST);
  // The month this line is ABOUT: the one the bank printed on it, else the earliest
  // month still owed.
  const target = hasTxnMonth ? tm : (firstOpen !== -1 ? firstOpen + 1 : null);
  // Corroboration is about money that still needs settling: the month has to be OPEN.
  // A deposit matching a month already covered corroborates nothing — it would record
  // the rent twice, which the review flags rather than pre-ticks.
  if (target && gaps[target - 1] > DUST) {
    const owedT = Number(owed[target - 1]) || 0;
    const gapT = gaps[target - 1];
    if (amountMatches(amount, owedT) || amountMatches(amount, gapT)) {
      return { corroborated: true, month: target, toRecon: false };
    }
    // A mid-year rent escalation explains a deposit still at the PRE-raise rate for a
    // post-step month — it's not short, the raise just hasn't been paid at the new
    // amount yet. Accept it and flag `escalated` so the review shows the quiet
    // "matches the pre-raise rate" cue instead of the amber short chip.
    const step = stepAtOrBefore(t.steps, target);
    if (owedT > DUST && step && amountMatches(amount, preStepOwed(owedT, step))) {
      return { corroborated: true, month: target, toRecon: false, escalated: true };
    }
  }
  if (firstOpen !== -1) {
    // k consecutive uncovered months' gap-sum (2..12) → untagged; Stage 1's FIFO
    // pool spreads one payment row correctly, no fake splits.
    let sum = 0;
    for (let i = firstOpen; i < 12; i++) {
      sum = round2(sum + gaps[i]);
      if (i > firstOpen && amountMatches(amount, sum)) return { corroborated: true, month: null, toRecon: false };
    }
  }
  // The whole year in one check.
  if (amountMatches(amount, t.invoiceTotal) || (t.invoiceBalance > 0 && amountMatches(amount, t.invoiceBalance))) {
    return { corroborated: true, month: null, toRecon: false };
  }
  // Autodate from the statement itself: nothing matched a billed figure, so the month
  // the money landed in is the honest default. Uncorroborated on purpose.
  if (hasTxnMonth) return { corroborated: false, month: tm, toRecon: false };
  return { corroborated: false, month: null, toRecon: false };
}

// Does a deposit's amount line up with what the ledger PROJECTS for the month it's
// being applied to? Returns null when there's nothing to flag — no month picked, the
// month bills nothing, or the amount matches the full charge OR the month's remaining
// gap (a legitimate top-up). Otherwise { projected, delta } where delta = amount −
// owed (negative = short, positive = over). Tolerance is amountMatches (±$1/1%), so a
// deposit the matcher already called "confident" can never also read as a mismatch.
export function depositProjectionDelta(amount, tenant, month) {
  const m = Number(month);
  if (!tenant || !(m >= 1 && m <= 12)) return null;
  const owed = round2(Number((tenant.owed || [])[m - 1]) || 0);
  if (owed <= DUST) return null;
  const cov = round2(Number((tenant.coverage || [])[m - 1]) || 0);
  const gap = round2(Math.max(0, owed - cov));
  if (amountMatches(amount, owed) || (gap > DUST && amountMatches(amount, gap))) return null;
  const delta = round2(Number(amount) - owed);
  // A short deposit that lands EXACTLY on the pre-raise rate for a post-step month is
  // explained by the escalation, not a real shortfall — carry an `escalation` marker
  // so the review renders the quiet cue. The key is present ONLY in that case.
  const step = stepAtOrBefore(tenant.steps, m);
  if (step) {
    const prevOwed = preStepOwed(owed, step);
    if (amountMatches(amount, prevOwed)) return { projected: owed, delta, escalation: { stepMonth: step.month, prevOwed } };
  }
  return { projected: owed, delta };
}

// Derive a tenant's monthly (and annual) CAM & tax estimate from ONE all-in bank
// deposit. The base rent is exact from the lease; a deposit is base + CAM&tax (+ roof,
// when the tenant is roof-responsible), so:
//   CAM&tax/mo = deposit − base − roof   →   ×12 = /yr   →   ÷SF = $/SF
// (George, 2026-07-24 — automating the reconstruction done by hand for Boost Mobile:
// $2,716 − $1,811.42 = $904.58/mo → $10,855.00/yr). Pure — nothing writes; the review
// SHOWS this and the landlord ticks + Saves. Escalation-aware by construction: `base`
// comes from the per-month schedule (componentizeSchedule), so a stepped tenant derives
// off the right month's base. Returns { monthly, annual, psf } or null when the figure
// can't be trusted:
//   - the month bills no base (out of term / abated) — nothing to subtract from,
//   - the remainder is under $1 — a gross lease, or a partial payment, not an estimate,
//   - the deposit is at the PRE-raise rate for a post-step month (the escalation
//     explains it; deriving off the raised base would understate the estimate),
//   - the derived annual already matches the estimate on file (nothing would change).
// tenant must carry baseByMonth / roofByMonth / owed / steps / square_footage /
// camTaxAnnual (getStatementMatchContext provides them). The annual is stored exact
// (penny-true so the deposit settles its month); the $/SF is shown to 4 decimals so
// George can validate the rate.
export function deriveEstimateFromDeposit(amount, tenant, month) {
  const m = Number(month);
  if (!tenant || !(m >= 1 && m <= 12)) return null;
  // A GROSS lease (0073) never bills an estimate — the flat rent already includes CAM
  // & tax, and its base line is that rent MINUS the carved share. So "deposit − base"
  // returns the share we just carved out and would propose it as a brand-new estimate
  // to bill on top. Refused outright rather than left to the <$1 heuristic below,
  // which only holds while the property has no expenses entered.
  if (tenant.gross) return null;
  const base = round2(Number((tenant.baseByMonth || [])[m - 1]) || 0);
  if (base <= DUST) return null; // the month bills no base rent — nothing to derive from
  const roof = round2(Number((tenant.roofByMonth || [])[m - 1]) || 0);
  // A deposit still at the pre-raise rate is explained by the escalation, not a new
  // estimate — deriving off the raised base would understate it.
  const step = stepAtOrBefore(tenant.steps, m);
  if (step) {
    const owedM = Number((tenant.owed || [])[m - 1]) || 0;
    if (owedM > DUST && amountMatches(Number(amount), preStepOwed(owedM, step))) return null;
  }
  const monthly = round2(Number(amount) - base - roof);
  if (monthly < 1) return null; // gross lease / partial payment — no meaningful estimate
  const annual = round2(monthly * 12);
  const current = round2(Number(tenant.camTaxAnnual) || 0);
  if (current > 0 && Math.abs(annual - current) <= 1) return null; // already at this estimate
  const sqft = Number(tenant.square_footage) || 0;
  // base/roof are the exact round2 figures the arithmetic used, so the review can show
  // deposit − base − roof = monthly to 4 decimals and have it visibly tie out.
  return { base, roof, monthly, annual, psf: sqft > 0 ? annual / sqft : null };
}

// The first saved rule (the payee memory) that matches one line: pattern contained in
// the normalized description AND direction-compatible with the target. Extracted from
// matchStatement so the save path can reuse the exact same test.
//   accountHint — the statement's masked account (e.g. "••4821"). When set, a rule
//   learned from THAT account is preferred (pass 1); otherwise any pattern match wins
//   (pass 2) — the fallback still recognizes a tenant who switched banks. A 2-arg call
//   (no hint) behaves exactly as before.
export function findMatchingRule(rules = [], txn, accountHint = null) {
  const desc = normalizeDesc(txn.description);
  const matches = (r) => {
    const pat = normalizeDesc(r.pattern);
    if (pat.length < 3 || !desc.includes(pat)) return false;
    return r.target_kind === 'ignore' || (r.target_kind === 'tenant' ? txn.direction === 'in' : txn.direction === 'out');
  };
  if (accountHint) {
    for (const r of rules) if (r.account_hint === accountHint && matches(r)) return r;
  }
  for (const r of rules) if (matches(r)) return r;
  return null;
}

// Rank every tenant for one deposit. Returns candidates sorted best-first:
//   { lease_id, property_id, property_name, tenant_name, score, corroborated,
//     month, toRecon, collision }
export function rankDepositCandidates(txn, tenants = []) {
  const out = [];
  const tm = monthOfDate(txn.date);
  for (const t of tenants) {
    const score = tenantNameScore(txn.description, t.tenant_name);
    if (score <= 0) continue;
    const corr = corroborateAmount(txn.amount, t, tm);
    // Hand-entry collision: the money this deposit represents is ALREADY covered
    // (no open gap it would fill, and no open recon) — likely recorded by hand.
    const gaps = (t.owed || []).map((o, i) => round2(Math.max(0, (Number(o) || 0) - (Number((t.coverage || [])[i]) || 0))));
    const openTotal = round2(gaps.reduce((s, g) => s + g, 0));
    const collision = !corr.toRecon && (openTotal <= DUST || (!corr.corroborated && amountMatches(txn.amount, t.monthly) && openTotal < txn.amount - DUST));
    out.push({
      lease_id: t.lease_id,
      property_id: t.property_id,
      property_name: t.property_name,
      tenant_name: t.tenant_name,
      score,
      corroborated: corr.corroborated,
      month: corr.month,
      toRecon: corr.toRecon,
      reconInvoiceId: corr.toRecon ? t.reconInvoiceId : null,
      collision,
    });
  }
  out.sort((a, b) => (b.score - a.score) || (Number(b.corroborated) - Number(a.corroborated)) || a.tenant_name.localeCompare(b.tenant_name));
  return out;
}

// Slice 4c — is this deposit a SECURITY DEPOSIT rather than rent?
//
// The stakes are asymmetric, which is what justifies guessing at all. A security
// deposit booked as rent credits that tenant's annual invoice, so allocatePayments
// reads the month over-paid and the Ledger's Collected column reports rent that never
// arrived — it corrupts a figure rather than omitting one. Amlak is the only tool that
// can catch it, because it holds the lease AND the bank line.
//
// ⚠ "DEPOSIT" ALONE IS NOT A SIGNAL and must never be treated as one. Every bank in
// America prints it on ordinary rent lines ("MOBILE DEPOSIT", "REMOTE DEPOSIT 4471"),
// so matching the bare word would reclassify a property's entire rent roll. Only the
// whole PHRASE counts — the same word-boundary lesson round 7 learned the hard way
// when "WITHDRAWAL" matched "DRAW".
const DEPOSIT_PHRASES = [/SECURITY\s+DEPOSIT/, /DAMAGE\s+DEPOSIT/, /\bSEC\s+DEP\b/];
const money2 = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function looksLikeSecurityDeposit(txn, cand, tenant) {
  if (!txn || txn.direction !== 'in' || !cand || !tenant) return null;
  const desc = String(txn.description || '').toUpperCase();
  // The strong signal: the bank line says so in words.
  if (DEPOSIT_PHRASES.some((re) => re.test(desc))) {
    return { lease_id: cand.lease_id, reason: 'the line says security deposit' };
  }
  // The quiet signal: it is exactly what this lease says is held, and it settles no
  // month the tenant owes. Both halves are required — an amount that corroborates a
  // billed month is rent that happens to resemble the deposit, which is common when
  // the deposit was set at one month's rent.
  const stated = Number(tenant.securityDeposit);
  if (!isFinite(stated) || stated <= 0) return null;
  if (cand.corroborated || cand.toRecon) return null;
  if (!amountMatches(txn.amount, stated)) return null;
  return { lease_id: cand.lease_id, reason: `matches the ${money2(stated)} deposit stated in this lease` };
}

const confidenceOf = (cand) => {
  if (!cand) return 'none';
  if (cand.score >= 0.8 && cand.corroborated) return 'high';
  if (cand.score >= 0.8 || (cand.score >= 0.5 && cand.corroborated)) return 'medium';
  if (cand.score >= 0.34) return 'low';
  return 'none';
};

// ---- The driver --------------------------------------------------------------
// matchStatement({ transactions, propertyId, tenants, rules, existingHashes })
// → { rows, propertyVote }
//   rows[i] = { txn, hash, year, duplicate, kind, candidate, candidates, label,
//               reason, month, confidence, checked, collision }
//   propertyVote = { propertyId, propertyName, count, total } when most matched
//   deposits belong to a DIFFERENT property than the page's (the pre-save banner).
export function matchStatement({ transactions = [], propertyId = null, tenants = [], rules = [], existingHashes = new Set(), accountHint = null } = {}) {
  const hashes = existingHashes instanceof Set ? existingHashes : new Set(existingHashes || []);
  const rows = [];
  for (const txn of transactions) {
    const hash = lineHash(txn);
    const year = Number(txn.date.slice(0, 4));
    const duplicate = hashes.has(hash);

    // 2) Rules first — suggest-only auto-confirm (account-hinted when known).
    const ruleHit = findMatchingRule(rules, txn, accountHint);
    if (ruleHit) {
      const t = ruleHit.target_kind === 'tenant' ? tenants.find((x) => x.lease_id === ruleHit.lease_id) : null;
      const corr = t ? corroborateAmount(txn.amount, t, monthOfDate(txn.date)) : { month: null, toRecon: false };
      rows.push({
        txn, hash, year, duplicate,
        kind: ruleHit.target_kind,
        candidate: t ? { lease_id: t.lease_id, property_id: t.property_id, property_name: t.property_name, tenant_name: t.tenant_name, score: 1, corroborated: !!corr.corroborated, month: corr.month, toRecon: corr.toRecon, reconInvoiceId: corr.toRecon ? t.reconInvoiceId : null, collision: false } : null,
        candidates: [],
        label: ruleHit.cam_label || null,
        reason: `rule: "${ruleHit.pattern}"`,
        month: corr.month ?? null,
        confidence: 'rule',
        checked: !duplicate && (ruleHit.target_kind !== 'tenant' || !!t),
        collision: false,
      });
      continue;
    }

    if (txn.direction === 'in') {
      const candidates = rankDepositCandidates(txn, tenants);
      const top = candidates[0] || null;
      const confidence = confidenceOf(top);
      // Slice 4c — before calling it rent, ask whether it is the security deposit.
      // Only when a tenant was actually recognized: a deposit has to belong to
      // somebody, and guessing the tenant as well as the kind would be two guesses
      // stacked. Suggestion only — it lands UNTICKED like everything else.
      const asDeposit = confidence !== 'none' && top
        ? looksLikeSecurityDeposit(txn, top, tenants.find((x) => x.lease_id === top.lease_id))
        : null;
      rows.push({
        txn, hash, year, duplicate,
        kind: asDeposit ? 'deposit_held' : (top && confidence !== 'none' ? 'tenant' : 'unmatched'),
        candidate: confidence !== 'none' ? top : null,
        candidates: candidates.slice(0, 4),
        label: null,
        reason: asDeposit ? asDeposit.reason : null,
        month: !asDeposit && confidence !== 'none' && top ? top.month : null,
        confidence,
        // Never auto-ticked. Money that is not rent must be confirmed by a human even
        // when the line says so in words — the cost of being wrong is a corrupted
        // Ledger, and there is no cheap way back from one.
        checked: !asDeposit && confidence === 'high' && !duplicate && !top.collision,
        collision: !asDeposit && !!top?.collision && confidence !== 'none',
      });
    } else {
      const cls = classifyWithdrawal(txn.description, tenants);
      rows.push({
        txn, hash, year, duplicate,
        kind: cls.kind,
        candidate: null,
        candidates: [],
        label: cls.label || null,
        reason: cls.reason || null,
        month: null,
        confidence: cls.confidence,
        checked: cls.kind !== 'ignore' && cls.confidence === 'high' && !duplicate,
        collision: false,
      });
    }
  }

  // Majority vote: the matched deposits know which property they belong to. When
  // most point AWAY from the page's property, the review offers to switch where
  // the statement's EXPENSES get recorded (deposits self-route regardless).
  let propertyVote = null;
  const votes = {};
  let total = 0;
  for (const r of rows) {
    if (r.kind === 'tenant' && r.candidate && (r.confidence === 'high' || r.confidence === 'rule' || r.confidence === 'medium')) {
      total++;
      const key = r.candidate.property_id;
      votes[key] = votes[key] || { count: 0, name: r.candidate.property_name };
      votes[key].count++;
    }
  }
  if (total >= 2 && propertyId) {
    const [bestId, best] = Object.entries(votes).sort((a, b) => b[1].count - a[1].count)[0] || [null, null];
    if (bestId && bestId !== propertyId && best.count * 2 > total) {
      propertyVote = { propertyId: bestId, propertyName: best.name, count: best.count, total };
    }
  }
  return { rows, propertyVote };
}
