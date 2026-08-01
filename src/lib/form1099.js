// Slice 7b — the 1099 worksheet. THE LIST AND THE QUESTION, NEVER THE FILING.
//
// A landlord must issue a 1099-NEC to any unincorporated vendor paid for SERVICES above
// the threshold in a calendar year — to the vendor AND the IRS by January 31, e-filed
// once there are ten or more returns, with penalties of roughly $60–$680 per form.
//
// ⚠ WHICH WAY THE REFUSALS POINT — AND IT IS THE OPPOSITE OF ROUND 11, ON PURPOSE.
// The closing-statement reader treats an unclassifiable charge as NOT basis, because
// guessing toward basis overstates what you own for thirty-nine years. Here the cost is
// reversed: a vendor left OFF this list is a form never filed and a penalty per form,
// while a vendor listed in error costs one question. So anything Amlak cannot rule out
// stays a CANDIDATE, and an unknown category is a candidate rather than an exclusion.
// The two modules refuse in opposite directions because their expensive directions are.
//
// ⚠ AND IT NEVER ASSERTS THE ONE FACT THAT DECIDES THE FILING. Whether a vendor is
// incorporated is answerable only by a W-9, and a C or S corp is exempt. Amlak names the
// candidates and asks; the W-9 column is deliberately blank, to be filled in with the
// accountant. That is also why this round stores nothing — there is no schema here,
// because the answer is not Amlak's to hold.
//
// Nothing in this file writes. No AI, no charge.
import { categoryFor, categoryLabel } from './expenseCategories';
import { contractCoversYear, contractAnnualCost } from './contracts';
import {
  getCorporation, listProperties, listExpenseBuckets, listEntityLedger,
  getExpenseRecord, listCamLineItems, listTaxLineItems, listRoofLineItems,
  listServiceContracts, listImportRules, listStatementImports, listStatementLines,
} from './api';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const FILING_DEADLINE = 'January 31';
export const EFILE_AT = 10;
export const PENALTY_NOTE =
  'A late or missing form runs roughly $60–$680 each depending on how late it is, so the ' +
  'expensive mistake here is leaving a vendor OFF — which is why anything that cannot be ' +
  'ruled out is listed.';

// ⚠ THE THRESHOLD MOVED, AND THIS FILE REFUSES TO HIDE ANYTHING BEHIND EITHER FIGURE.
// $600 stood for decades; the July 2025 law raised it to $2,000 for payments made after
// 31 December 2025, indexed after that. Getting it wrong is costly in both directions —
// too high misses a required filing, too low buries the real candidates in noise — so
// the threshold is a LINE ACROSS the list, never a filter: every vendor is returned,
// and the ones below the line are still listed and counted.
export const THRESHOLDS = [
  { from: 0, amount: 600 },
  { from: 2026, amount: 2000 },
];
export const THRESHOLD_NOTE =
  'The reporting threshold was $600 for years through 2025 and $2,000 for payments made ' +
  'from 2026 onward, indexed for inflation after that. Confirm the figure for the year ' +
  'you are filing — every vendor is listed either way, so nothing is hidden by it.';

export function thresholdFor(year) {
  const y = Number(year) || 0;
  let hit = THRESHOLDS[0];
  for (const t of THRESHOLDS) if (y >= t.from) hit = t;
  return hit.amount;
}

// ── What kind of payment it was ──────────────────────────────────────────────
// Keyed off round 4's tax category, so the decision a landlord already made once per
// bucket does double duty here. Same registry idiom as ASSET_KINDS / ENTITY_KINDS /
// COST_TREATMENTS — a JS list, no CHECK, no migration to refine it.
export const VENDOR_TREATMENTS = [
  {
    key: 'ask',
    report: 'ask',
    label: 'Ask for a W-9',
    why: 'Services are reportable unless the vendor is a corporation — and only a W-9 answers that.',
  },
  {
    key: 'attorney',
    report: 'always',
    label: 'Report even if incorporated',
    why: 'Legal fees are reported whether or not the firm is incorporated — the exemption every other corporation gets does not apply to attorneys. This is the most commonly missed 1099 there is.',
  },
  {
    key: 'goods',
    report: 'no',
    label: 'Merchandise, not services',
    why: 'Payments for merchandise and materials are outside 1099 reporting.',
  },
  {
    key: 'utility',
    report: 'no',
    label: 'Utilities and freight',
    why: 'Telephone, utilities, freight and storage are outside 1099 reporting by regulation — whoever the vendor is, incorporated or not.',
  },
  {
    key: 'government',
    report: 'no',
    label: 'A government body',
    why: 'A county treasurer or a department of revenue is not a 1099 recipient.',
  },
  {
    key: 'other_form',
    report: 'no',
    label: 'A different form',
    why: 'Interest is reported on Form 1098 or 1099-INT by the lender, not on a 1099-NEC by you.',
  },
  {
    key: 'payroll',
    report: 'no',
    label: 'W-2, not 1099',
    why: 'An employee is paid on a W-2. Amlak does not run payroll, so nothing here should land under Wages.',
  },
  {
    key: 'noncash',
    report: 'no',
    label: 'Not a payment',
    why: 'Depreciation is a book figure — no money left the account, so there is nobody to report.',
  },
];

const BY_TREATMENT = new Map(VENDOR_TREATMENTS.map((t) => [t.key, t]));

// Every category resolves, and the ones that do NOT are candidates rather than
// exclusions — see the header. `other` is deliberately `ask`: it genuinely could be
// anything, and "could be anything" is exactly when you ask for the W-9.
const CATEGORY_TREATMENT = {
  advertising: 'ask',
  auto_travel: 'ask',
  cleaning: 'ask',
  commissions: 'ask',
  management: 'ask',
  insurance: 'ask',
  interest: 'other_form',
  legal: 'attorney',
  taxes: 'government',
  repairs: 'ask',
  supplies: 'goods',
  utilities: 'utility',
  wages: 'payroll',
  depreciation: 'noncash',
  other: 'ask',
};

// The standing refusal, one more time: a category written by a later round and read by
// an older bundle reports itself as unknown rather than inheriting another's answer.
// Unlike treatmentInfo / assetKindInfo / entityKindInfo, unknown here is not inert — it
// still produces a CANDIDATE, because the safe direction on this form is to ask.
export function treatmentFor(categoryKey) {
  const t = CATEGORY_TREATMENT[categoryKey];
  return t ? BY_TREATMENT.get(t) : null;
}

export const treatmentInfo = (key) => BY_TREATMENT.get(key) || null;

// 'always' beats 'ask' beats 'no'. A vendor paid into two buckets takes the most
// reportable of them, because half a reportable relationship is still reportable.
const RANK = { always: 2, ask: 1, no: 0 };

// ── How it was paid ──────────────────────────────────────────────────────────
// ⚠ THE EXCLUSION NOBODY REMEMBERS, AND IT DOUBLE-REPORTS THE VENDOR WHEN MISSED.
// A payment made by credit card, debit card or a third-party network is reported by the
// PROCESSOR on a 1099-K. Putting it on your 1099-NEC as well reports the same money
// twice against that vendor. Cheques, ACH and cash are yours to report; card is not.
//
// Deliberately NOT sharing statementMatch's BANK_NOISE, though the words overlap: that
// list answers "is this token part of a payee name" and this one answers "did this
// payment ride a card network" — VISA appears in both for opposite reasons, and merging
// them would tie two unrelated rules together. Word-boundary matched, per the round-7
// lesson where "WITH*DRAW*AL" read as an owner draw.
const CARD_RAILS = [
  /(^| )VISA( |$)/, /(^| )MASTERCARD( |$)/, /(^| )MC( |$)/, /(^| )AMEX( |$)/,
  /(^| )DISCOVER( |$)/, /(^| )POS( |$)/, /(^| )CARD( |$)/, /(^| )DEBIT CARD( |$)/,
  /(^| )CREDIT CARD( |$)/, /(^| )CARD PURCHASE( |$)/,
  /(^| )PAYPAL( |$)/, /(^| )VENMO( |$)/, /(^| )SQUARE( |$)/, /(^| )STRIPE( |$)/,
  /(^| )ZELLE( |$)/,
];

const normalizeDesc = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function paidByCard(description) {
  const d = normalizeDesc(description);
  if (!d) return false;
  return CARD_RAILS.some((re) => re.test(d));
}

// ── Who was paid ─────────────────────────────────────────────────────────────
// One vendor under two spellings is one vendor: "Groot, Inc." and "GROOT INC" merge.
export const vendorKey = (name) =>
  String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "1 vendor carries" / "4 vendors carry" — a count of one must not read "1 carry no tax
// category", which is what the worksheet said until it was seen on a real portfolio with
// exactly one uncategorised bucket. Exported rather than written twice so the flags on
// screen and the same flags in the workbook can't word one fact two ways (§3).
export const vendorPhrase = (n, singularVerb, pluralVerb) =>
  `${n} vendor${n === 1 ? '' : 's'} ${n === 1 ? singularVerb : pluralVerb}`;

// ⚠ AMLAK DOES NOT RELIABLY KNOW THE PAYEE, AND THE WORKSHEET SAYS SO PER ROW.
// `cam_line_items` has a bucket LABEL, not a payee — "Repairs" can cover three
// contractors, and a bucket named "Comcast" happens to be a payee only by luck. So each
// row carries where its name came from, and how far to trust it.
export const PAYEE_SOURCES = {
  contract: { label: 'Service contract', precise: true, note: 'the vendor named on the contract' },
  rule: { label: 'Learned payee', precise: true, note: 'the payee Amlak learned from your bank statement' },
  entity: { label: 'Entity cost', precise: true, note: 'recorded under Owner & entity money' },
  bucket: { label: 'Expense bucket', precise: false, note: 'grouped by expense bucket, not by payee — one bucket can cover more than one vendor' },
};

const EXPENSE_KINDS = ['tax', 'cam', 'roof'];
const KIND_CATEGORY = { tax: 'taxes', roof: 'repairs' };

// Round 5's rule, reused: a kind with a positive total and NO line items is a single flat
// figure with no payee attached to any part of it. Round 3's carryFlatIntoItems guarantees
// the converse — the first time anything is itemized the flat figure is carried in as a
// line — so "itemized" means "complete", and only an un-itemized kind is unattributable.
function unattributedTotal(items, expense) {
  const totalFor = { tax: num(expense.taxes_total), cam: num(expense.cam_total), roof: num(expense.roof_total) };
  let out = 0;
  for (const kind of EXPENSE_KINDS) {
    if (totalFor[kind] > 0 && !items.some((i) => (i.kind || 'cam') === kind)) out += totalFor[kind];
  }
  return round2(out);
}

/**
 * The pure core: one property's expense lines, contracts and lines → vendor totals.
 * Returns { vendors, unattributed, skipped } — never filtered by threshold, because
 * the threshold is a line across the list rather than a gate on it.
 */
export function vendorRowsFor({ property, items = [], contracts = [], expense = {}, buckets = [], rules = [], lines = [], year }) {
  const y = Number(year);
  const propName = property?.name || 'Unnamed property';

  // A learned payee points at a bucket, so the bucket label is the join key: a rule
  // reading "OTIS ELEVATOR → Elevator service" names who the Elevator service money
  // went to. Only expense rules — a tenant rule names who paid YOU.
  const payeeByBucket = new Map();
  for (const r of rules) {
    if (!r || !String(r.target_kind || '').startsWith('expense')) continue;
    const b = vendorKey(r.cam_label);
    if (b && r.pattern && !payeeByBucket.has(b)) payeeByBucket.set(b, String(r.pattern).trim());
  }

  const vendorByContract = new Map();
  for (const c of contracts) if (c?.id) vendorByContract.set(c.id, c.vendor || c.name || null);

  // Provenance for the card check: the statement line a given expense line produced.
  const lineByRef = new Map();
  for (const l of lines) if (l?.ref_id) lineByRef.set(l.ref_id, l);

  const acc = new Map();
  const skipped = [];

  const push = ({ name, source, amount, categoryKey, description, kindLabel }) => {
    const key = vendorKey(name);
    if (!key || !(amount > 0)) return;
    if (!acc.has(key)) {
      acc.set(key, {
        key, name: String(name).trim(), total: 0, cardTotal: 0, count: 0,
        // null until the first line is seen — 'no' is a real answer a line can give, so
        // seeding it as 'no' would make the first excluded line indistinguishable from
        // "nothing observed yet" and lose its treatment (and therefore its reason).
        source, categories: new Set(), properties: new Set(), report: null,
        treatmentKey: null, anyUnknownCategory: false, methodKnown: false,
      });
    }
    const v = acc.get(key);
    // The most precise name wins the display, so a bucket row never overwrites a
    // contract's real vendor name.
    if (PAYEE_SOURCES[source]?.precise && !PAYEE_SOURCES[v.source]?.precise) {
      v.source = source;
      v.name = String(name).trim();
    }
    v.total = round2(v.total + amount);
    v.count += 1;
    v.properties.add(propName);
    if (kindLabel) v.categories.add(kindLabel);

    // An unresolvable category is a candidate, not an exclusion — the header's rule.
    const t = categoryKey ? treatmentFor(categoryKey) : null;
    if (!t) v.anyUnknownCategory = true;
    const level = t ? t.report : 'ask';
    if (v.report === null || RANK[level] > RANK[v.report]) { v.report = level; v.treatmentKey = t ? t.key : null; }

    if (description != null) {
      v.methodKnown = true;
      if (paidByCard(description)) v.cardTotal = round2(v.cardTotal + amount);
    }
  };

  for (const it of items) {
    const amount = num(it.amount);
    if (!(amount > 0)) continue;

    // ⚠ An amortized capital cost is a BOOK entry, not a payment made this year — the
    // money left in the year the asset was bought and was reportable then. Counting it
    // again every year of its life would invent a vendor payment that never happened.
    if (it.asset_id) {
      skipped.push({ label: it.label || '—', amount: round2(amount), property: propName, why: 'a capital cost spread over its life — the payment happened in the year it was bought, not this one' });
      continue;
    }

    const kind = EXPENSE_KINDS.includes(it.kind) ? it.kind : 'cam';
    const label = String(it.label || '').trim() || '—';

    // Name, most precise first.
    let name = null;
    let source = 'bucket';
    if (it.contract_id && vendorByContract.get(it.contract_id)) {
      name = vendorByContract.get(it.contract_id);
      source = 'contract';
    } else if (payeeByBucket.has(vendorKey(label))) {
      name = payeeByBucket.get(vendorKey(label));
      source = 'rule';
    } else {
      name = label;
    }

    // Category: the saved bucket wins, then the label registry, then what the SECTION
    // means — a tax-list row IS a real-estate tax and a roof row IS repair work. Round
    // 5's fourth tier, reused, so only CAM is ever genuinely ambiguous.
    const resolved = categoryFor(label, buckets);
    const categoryKey = resolved.category || KIND_CATEGORY[kind] || null;

    const st = lineByRef.get(it.id);
    push({
      name, source, amount, categoryKey,
      description: st ? st.description : null,
      kindLabel: categoryKey ? categoryLabel(categoryKey) : 'Not categorized',
    });
  }

  // A contract that covers the year but produced no line item (its property's year was
  // never opened, so syncContractCamItems never ran) would otherwise be missing entirely.
  const seenContract = new Set(items.filter((i) => i.contract_id).map((i) => i.contract_id));
  for (const c of contracts) {
    if (!c || seenContract.has(c.id) || !contractCoversYear(c, y)) continue;
    const amount = round2(contractAnnualCost(c, y));
    if (!(amount > 0)) continue;
    push({
      name: c.vendor || c.name, source: 'contract', amount,
      categoryKey: categoryFor(c.name || '', buckets).category,
      description: null, kindLabel: 'Service contract',
    });
  }

  return { vendors: [...acc.values()], unattributed: unattributedTotal(items, expense), skipped };
}

// Merge the per-property accumulators into one list for the entity, then decide each
// vendor's standing against the threshold.
function finalize(parts, threshold) {
  const acc = new Map();
  for (const v of parts) {
    if (!acc.has(v.key)) { acc.set(v.key, { ...v, categories: new Set(v.categories), properties: new Set(v.properties) }); continue; }
    const t = acc.get(v.key);
    t.total = round2(t.total + v.total);
    t.cardTotal = round2(t.cardTotal + v.cardTotal);
    t.count += v.count;
    v.categories.forEach((c) => t.categories.add(c));
    v.properties.forEach((p) => t.properties.add(p));
    if (t.report === null || RANK[v.report] > RANK[t.report]) { t.report = v.report; t.treatmentKey = v.treatmentKey; }
    t.anyUnknownCategory = t.anyUnknownCategory || v.anyUnknownCategory;
    t.methodKnown = t.methodKnown || v.methodKnown;
    if (PAYEE_SOURCES[v.source]?.precise && !PAYEE_SOURCES[t.source]?.precise) { t.source = v.source; t.name = v.name; }
  }

  return [...acc.values()].map((v) => {
    // ⚠ Only the NON-card portion counts toward the threshold — the card portion is the
    // processor's to report, so including it could push a vendor over a line they never
    // crossed with money you are responsible for reporting.
    const reportable = round2(v.total - v.cardTotal);
    return {
      key: v.key,
      name: v.name,
      total: v.total,
      cardTotal: v.cardTotal,
      reportable,
      count: v.count,
      source: v.source,
      precise: !!PAYEE_SOURCES[v.source]?.precise,
      categories: [...v.categories].sort(),
      properties: [...v.properties].sort(),
      report: v.report || 'ask',
      treatment: v.treatmentKey ? BY_TREATMENT.get(v.treatmentKey) || null : null,
      needsCategory: v.anyUnknownCategory,
      methodKnown: v.methodKnown,
      crosses: reportable >= threshold,
    };
  }).sort((a, b) => b.reportable - a.reportable || a.name.localeCompare(b.name));
}

/**
 * The worksheet itself. Splits into three lists that together account for every dollar
 * of expense the entity recorded — round 6's rule, applied to vendors instead of bank
 * lines: a payment is a candidate, is below the line, or is excluded WITH A REASON.
 */
export function worksheet({ vendors = [], entityCosts = [], draws = [], unattributed = 0, skipped = [], year, threshold: given = null }) {
  const threshold = given ?? thresholdFor(year);
  const rows = finalize([...vendors, ...entityCosts], threshold);

  const reportable = rows.filter((r) => r.report !== 'no');
  const candidates = reportable.filter((r) => r.crosses);
  const below = reportable.filter((r) => !r.crosses);
  const excluded = rows.filter((r) => r.report === 'no');

  const cardTotal = round2(rows.reduce((s, r) => s + r.cardTotal, 0));
  const noMethod = candidates.filter((r) => !r.methodKnown).length;

  return {
    year: Number(year),
    threshold,
    candidates,
    below,
    excluded,
    // Everything deliberately not on the worksheet, each with its reason — the sheet
    // that makes the rest of it trustworthy, exactly as round 12's does for the return.
    leftOff: {
      draws: round2(draws.reduce((s, d) => s + Math.abs(num(d.amount)), 0)),
      drawCount: draws.length,
      unattributed: round2(unattributed),
      capital: round2(skipped.reduce((s, k) => s + k.amount, 0)),
      capitalRows: skipped,
      excludedTotal: round2(excluded.reduce((s, r) => s + r.total, 0)),
      cardTotal,
    },
    counts: {
      candidates: candidates.length,
      below: below.length,
      excluded: excluded.length,
      needsCategory: candidates.filter((r) => r.needsCategory).length,
      imprecise: candidates.filter((r) => !r.precise).length,
      noMethod,
      efile: candidates.length >= EFILE_AT,
    },
  };
}

// ── The fetcher ──────────────────────────────────────────────────────────────
export async function build1099Worksheet({ corporationId, year }) {
  const y = Number(year);
  const [corporation, properties, buckets, rules, entityRows] = await Promise.all([
    getCorporation(corporationId),
    listProperties(corporationId),
    listExpenseBuckets().catch(() => []),
    listImportRules().catch(() => []),
    listEntityLedger({ corporationId, year: y }).catch(() => []),
  ]);

  const parts = await Promise.all((properties || []).map(async (property) => {
    const [expense, cam, tax, roof, contracts, imports] = await Promise.all([
      getExpenseRecord(property.id, y).catch(() => ({})),
      listCamLineItems(property.id, y).catch(() => []),
      listTaxLineItems(property.id, y).catch(() => []),
      listRoofLineItems(property.id, y).catch(() => []),
      listServiceContracts(property.id).catch(() => []),
      listStatementImports(property.id, y).catch(() => []),
    ]);
    // Round 6's audit rows are what make the card check possible. They are forward-only
    // — a statement imported before that round has none — which is exactly why a vendor
    // with no line records reports its payment method as UNKNOWN rather than as cheque.
    const lines = (await Promise.all(
      (imports || []).map((imp) => listStatementLines(imp.id).catch(() => []))
    )).flat();

    return vendorRowsFor({
      property, items: [...tax, ...cam, ...roof], contracts,
      expense: expense || {}, buckets, rules, lines, year: y,
    });
  }));

  // An entity COST is a real payment to a real vendor and belongs here. A draw or a
  // contribution is not a payment for services at all, so it is named on the left-off
  // list rather than silently absent — round 7's distinction, carried onto the form.
  const costs = (entityRows || []).filter((r) => r.kind === 'cost');
  const draws = (entityRows || []).filter((r) => r.kind !== 'cost');
  const entityCosts = costs.map((c) => {
    const t = treatmentFor(c.category);
    return {
      key: vendorKey(c.label || 'Entity cost'),
      name: String(c.label || 'Entity cost').trim(),
      total: round2(Math.abs(num(c.amount))),
      cardTotal: 0,
      count: 1,
      source: 'entity',
      categories: new Set([c.category ? categoryLabel(c.category) : 'Not categorized']),
      properties: new Set([corporation?.name || 'Entity']),
      report: t ? t.report : 'ask',
      treatmentKey: t ? t.key : null,
      anyUnknownCategory: !t,
      methodKnown: false,
    };
  });

  return {
    corporation: corporation || {},
    ...worksheet({
      vendors: parts.flatMap((p) => p.vendors),
      entityCosts,
      draws,
      unattributed: round2(parts.reduce((s, p) => s + p.unattributed, 0)),
      skipped: parts.flatMap((p) => p.skipped),
      year: y,
    }),
  };
}
