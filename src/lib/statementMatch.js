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

// The "always match {payee}" pattern suggested from one statement line: the
// longest CONTIGUOUS run of digit-free tokens — contiguous because matching is a
// plain `contains`, and check/reference numbers change every month ("CHECK 1044
// CITY DENTAL PC" → "CITY DENTAL PC" still matches next month's CHECK 1045).
export function suggestRulePattern(description) {
  const tokens = normalizeDesc(description).split(' ');
  let best = [];
  let cur = [];
  for (const t of tokens) {
    if (/\d/.test(t)) { if (cur.join(' ').length > best.join(' ').length) best = cur; cur = []; }
    else cur.push(t);
  }
  if (cur.join(' ').length > best.join(' ').length) best = cur;
  const pat = best.join(' ');
  return pat.length >= 3 ? pat : null;
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
const IGNORE_KEYWORDS = [
  ['MORTGAGE', 'a mortgage payment is not a recoverable CAM expense'],
  ['LOAN', 'loan payments are not operating expenses'],
  ['TRANSFER', 'internal transfer'],
  ['DRAW', 'owner draw'],
];

// The built-in bucket names the review dropdown offers alongside the owner's own
// buckets (every keyword hit is a billable CAM bucket).
export const CAM_KEYWORD_LABELS = CAM_KEYWORDS.map(([, label]) => label);

// Classify one money-OUT line. Returns { kind, label?, reason?, confidence }.
// Unknown money-out → suggest ignore (never auto-booked).
export function classifyWithdrawal(description, tenants = []) {
  const desc = normalizeDesc(description);
  for (const [kw, reason] of IGNORE_KEYWORDS) {
    if (desc.includes(kw)) return { kind: 'ignore', reason, confidence: 'high' };
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
//             reconInvoiceId?, reconBalance? }]
// Amount corroboration against ONE tenant. Returns
//   { corroborated, month (1-12|null), toRecon } — month null = untagged (FIFO).
export function corroborateAmount(amount, t) {
  // An open reconciliation true-up: the check that settles it matches its balance.
  if (t.reconBalance > 0 && amountMatches(amount, t.reconBalance)) {
    return { corroborated: true, month: null, toRecon: true };
  }
  const owed = t.owed || [];
  const cov = t.coverage || [];
  const gaps = owed.map((o, i) => round2(Math.max(0, (Number(o) || 0) - (Number(cov[i]) || 0))));
  const firstOpen = gaps.findIndex((g) => g > DUST);
  // One month's billed charge → the earliest uncovered owed month.
  if (firstOpen !== -1) {
    if (amountMatches(amount, owed[firstOpen]) || amountMatches(amount, gaps[firstOpen])) {
      return { corroborated: true, month: firstOpen + 1, toRecon: false };
    }
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
  return { corroborated: false, month: null, toRecon: false };
}

// Rank every tenant for one deposit. Returns candidates sorted best-first:
//   { lease_id, property_id, property_name, tenant_name, score, corroborated,
//     month, toRecon, collision }
export function rankDepositCandidates(txn, tenants = []) {
  const out = [];
  for (const t of tenants) {
    const score = tenantNameScore(txn.description, t.tenant_name);
    if (score <= 0) continue;
    const corr = corroborateAmount(txn.amount, t);
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
export function matchStatement({ transactions = [], propertyId = null, tenants = [], rules = [], existingHashes = new Set() } = {}) {
  const hashes = existingHashes instanceof Set ? existingHashes : new Set(existingHashes || []);
  const rows = [];
  for (const txn of transactions) {
    const hash = lineHash(txn);
    const year = Number(txn.date.slice(0, 4));
    const duplicate = hashes.has(hash);
    const desc = normalizeDesc(txn.description);

    // 2) Rules first — suggest-only auto-confirm.
    let ruleHit = null;
    for (const r of rules) {
      const pat = normalizeDesc(r.pattern);
      if (pat.length < 3 || !desc.includes(pat)) continue;
      const dirOk = r.target_kind === 'ignore' || (r.target_kind === 'tenant' ? txn.direction === 'in' : txn.direction === 'out');
      if (!dirOk) continue;
      ruleHit = r;
      break;
    }
    if (ruleHit) {
      const t = ruleHit.target_kind === 'tenant' ? tenants.find((x) => x.lease_id === ruleHit.lease_id) : null;
      const corr = t ? corroborateAmount(txn.amount, t) : { month: null, toRecon: false };
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
      rows.push({
        txn, hash, year, duplicate,
        kind: top && confidence !== 'none' ? 'tenant' : 'unmatched',
        candidate: confidence !== 'none' ? top : null,
        candidates: candidates.slice(0, 4),
        label: null,
        reason: null,
        month: confidence !== 'none' && top ? top.month : null,
        confidence,
        checked: confidence === 'high' && !duplicate && !top.collision,
        collision: !!top?.collision && confidence !== 'none',
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
