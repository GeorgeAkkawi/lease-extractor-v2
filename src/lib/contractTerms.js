// What a newly-uploaded contract document would CHANGE on the service contract it replaces.
//
// The contract-side twin of newLeaseTerms.js, and it exists for the same reason: replacing
// the document without moving the figures leaves the app showing one number while the
// document beside it says another. So the diff is computed and SHOWN before anything is
// written, because these are billed figures — a contract's fee becomes a CAM line item,
// which becomes expense_records.cam_total, which becomes every tenant's share, which becomes
// a stored invoice (CLAUDE.md §1).
//
// ⚠ THE HARD RULE, and it is the reason George's constraint holds automatically.
// George, 2026-08-05: *"this only affects the ACTUAL CAM and Tax not estimated."*
// NOTHING on the contract path may write leases.est_cam_annual / est_tax_annual /
// est_roof_annual / est_confirmed_year, or a lease_estimates row. Not as a restraint — as a
// mechanism. resyncPropertyBilling → resyncYearBillingToEstimate prices from
// billedComponents(share), which PREFERS a tenant's estimate and falls back to the actual
// share (share.cam_amount). Write nothing, and the behaviour George asked for falls out of
// code that already exists: a tenant on an estimate keeps paying it and settles the
// difference at ⚖ Reconcile; a tenant with no estimate is billed the actual share, so their
// invoice moves now. Adding an estimate write here would break both halves at once.
//
// Pure on purpose — no supabase, no React. applyNewContractTerms (api.js) does the writing
// and the billing carry-through; this only decides what is different.

import { isoDateOrNull } from './isoDate';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The AI returns each scalar as { value, confidence, source_quote, page }; older deploys and
// the paste path can return a bare value. Read either shape — which is what makes the deploy
// order forgiving (a frontend that ships before the edge function still reads what it gets).
const val = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

/**
 * The contract's own columns, in the order a landlord reads them.
 *
 * `billed: true` marks exactly the fields that change contractAnnualCost() or
 * contractCoversYear() — the only route from this document to a CAM row, to cam_total, to a
 * tenant's share, to a stored invoice. `frequency` is billed for two reasons, not one:
 * monthly means ×12, and 'one-time' REMOVES the contract from every year but its first.
 *
 * `ex` is the extraction's key when it differs from the column's.
 *
 * ⚠ `name` is NOT in this list and is never auto-applied. The tenant_name precedent, but
 * stronger: a contract's name is the CAM line item's LABEL (api.js), the alert TITLE
 * (alerts.js) and the reminder email's SUBJECT. A document that prints the trading name
 * slightly differently would silently relabel a Financials line and retitle a live alert.
 * Renaming stays a deliberate act on the Edit form.
 */
export const FIELDS = [
  { key: 'service_type', label: 'Type', kind: 'text' },
  { key: 'vendor', label: 'Vendor', kind: 'text' },
  { key: 'vendor_email', label: 'Vendor email', kind: 'text' },
  { key: 'amount', label: 'Fee', kind: 'money', billed: true },
  { key: 'frequency', label: 'Frequency', kind: 'text', billed: true },
  { key: 'escalation_pct', label: 'Escalation %/yr', kind: 'number', billed: true },
  { key: 'start_date', label: 'Start', kind: 'date', billed: true },
  { key: 'end_date', label: 'End', kind: 'date', billed: true },
  { key: 'auto_renew', label: 'Auto-renews', kind: 'bool' },
  { key: 'notice_days', label: 'Cancellation notice', kind: 'number', ex: 'cancellation_notice_days' },
  { key: 'notice_by_date', label: 'Notice due by', kind: 'date' },
  { key: 'renewal_term_months', label: 'Renewal term (months)', kind: 'number' },
];

const NUMERIC = new Set(['money', 'number']);
const DATE_KEYS = FIELDS.filter((f) => f.kind === 'date').map((f) => f.key);

// Two values are "the same" when they mean the same thing, not when they look it.
function same(kind, a, b) {
  if (NUMERIC.has(kind)) {
    const x = num(a); const y = num(b);
    if (x === null && y === null) return true;
    return x !== null && y !== null && Math.abs(x - y) < 0.005;
  }
  if (kind === 'bool') {
    const x = a === null || a === undefined ? null : Boolean(a);
    const y = b === null || b === undefined ? null : Boolean(b);
    return x === y;
  }
  return text(a) === text(b);
}

// Per-field confidence from an AI read, for the badges on the contract row. Stored on the
// contract so a badge always describes the document currently on file.
export function buildContractConfidence(ex) {
  const map = {};
  for (const f of FIELDS) {
    const raw = ex?.[f.ex || f.key];
    if (raw && typeof raw === 'object' && raw.confidence != null) map[f.key] = raw.confidence;
  }
  return Object.keys(map).length ? map : null;
}

// How a raw fee figure converts to an ANNUAL amount. 'per_season' annualizes at ×1 — a snow
// contract's season fee IS its yearly cost, which is exactly how the pre-0091 escalation
// scalar treated it. 'per_visit' and 'unknown' are deliberately absent: a per-visit rate
// needs a visit count the document does not state, and guessing one is how a $95 call-out
// becomes a year of CAM.
const ANNUALIZE = { per_month: 12, per_year: 1, per_season: 1, one_time: 1 };

const addMonths = (iso, months) => {
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + Number(months));
  // Clamp to the last day of the landing month, so +1 month from the 31st is not +2.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Turn the document's raw fee table into the contract_escalations rows that would be written.
 *
 * THE MODEL READS, THE CODE MULTIPLIES. Each row arrives as the figure exactly as printed
 * plus its basis; the annualization, the offset anchoring, and the conversion into the
 * contract's own frequency all happen here — the same rule the lease's rent schedule follows,
 * for the same reason (models read reliably and multiply unreliably).
 *
 * ⚠ new_amount comes out in the CONTRACT'S OWN frequency, because that is what
 * service_contracts.amount is and what contractAnnualCost() annualizes. A monthly contract
 * gets monthly figures.
 *
 * @param extraction  the raw AI read
 * @param targets     contractTargets() — what the contract WILL BE (frequency + start date)
 * @returns { steps, undated, unusable }
 */
export function buildContractFeeSteps(extraction, targets) {
  const rows = Array.isArray(extraction?.fee_schedule) ? extraction.fee_schedule : [];
  const startIso = isoDateOrNull(text(targets?.startDate)) ? text(targets.startDate) : null;
  const monthly = targets?.frequency === 'monthly';
  const steps = [];
  let undated = 0;   // a row we can't place on the calendar (no date, no anchorable offset)
  let unusable = 0;  // a row whose basis can't be annualized (per_visit / unknown / no amount)
  const seen = new Set();

  for (const r of rows) {
    const amount = num(r?.amount);
    const factor = ANNUALIZE[r?.period];
    if (amount === null || amount <= 0 || !factor) { unusable += 1; continue; }

    let date = text(r?.effective_date);
    date = date && isoDateOrNull(date) ? date : null;
    if (!date) {
      const off = num(r?.months_from_start);
      // An offset with no start date to anchor it is not a date. Say so rather than
      // inventing one off today — the whole schedule would land in the wrong years.
      date = off !== null && startIso ? addMonths(startIso, off) : null;
    }
    if (!date) { undated += 1; continue; }
    if (seen.has(date)) continue;
    seen.add(date);

    const annual = round2(amount * factor);
    steps.push({
      effective_date: date,
      new_amount: monthly ? round2(annual / 12) : annual,
      escalation_type: 'manual',
      escalation_value: null,
      source: 'contract',
      note: text(r?.quote) ? text(r.quote).slice(0, 2000) : null,
    });
  }
  steps.sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
  return { steps, undated, unusable };
}

/**
 * @param contract    the contract as it stands
 * @param extraction  the raw AI read
 * @param plan        buildContractFeeSteps' output — the rows that would ACTUALLY be written,
 *                    not the raw row count. A fee table printed by contract year with no date
 *                    the start could anchor cannot be scheduled, and promising steps that
 *                    never land is worse than saying so.
 * @returns { fields, guessedDates, unusableDates, noticeDerived, touchesBilling, feeSteps,
 *            undatedSteps, unusableSteps }
 *
 * A field appears ONLY when the new document actually states something for it. A contract the
 * AI couldn't read a vendor email out of must not blank the one already on file — silence in
 * a document is not an instruction to erase.
 */
export function contractChanges({ contract, extraction, plan = null } = {}) {
  const stated = {};
  for (const f of FIELDS) {
    const raw = val(extraction?.[f.ex || f.key]);
    if (raw === null || raw === undefined || raw === '') continue;
    stated[f.key] = f.kind === 'bool' ? Boolean(raw) : raw;
  }

  // ── DATES THAT AREN'T REAL DAYS ───────────────────────────────────────────────────────
  // A date field goes verbatim into a Postgres `date` column, so "2033-04-31" — which models
  // really do return, and which V8 parses happily by rolling to May 1 — would fail the ENTIRE
  // apply with `date/time field value out of range`. There are no fields in the review dialog
  // to correct it in, so drop the unusable value, keep the rest of the document, and name what
  // the document actually printed.
  const unusableDates = [];
  for (const key of DATE_KEYS) {
    const raw = stated[key];
    if (raw === undefined || text(raw) === '' || isoDateOrNull(text(raw))) continue;
    unusableDates.push({ key, label: FIELDS.find((f) => f.key === key)?.label || key, printed: String(raw) });
    delete stated[key];
  }

  // ── THE NOTICE DATE, DERIVED ──────────────────────────────────────────────────────────
  // Most contracts state the notice window in prose ("thirty (30) days written notice prior to
  // expiration") and print no deadline at all. That prose is enough to compute the date, and
  // the date is what arms the reminder — so it is computed rather than left null. But it is
  // NOT a date the document printed, and the dialog has to say so: a landlord acting on a
  // deadline the app inferred deserves to know the app inferred it.
  let derivedNotice = null;
  if (stated.notice_by_date === undefined) {
    const days = num(stated.notice_days ?? contract?.notice_days);
    const end = text(stated.end_date ?? contract?.end_date);
    const derived = noticeDueDate(end, days);
    if (derived) {
      stated.notice_by_date = derived;
      derivedNotice = { value: derived, days, from: end };
    }
  }

  const fields = [];
  for (const f of FIELDS) {
    const to = stated[f.key];
    if (to === undefined) continue;
    const says = NUMERIC.has(f.kind) ? num(to) !== null : f.kind === 'bool' ? to !== null : text(to) !== '';
    if (!says) continue;
    const from = contract?.[f.key];
    if (same(f.kind, from, to)) continue;
    fields.push({ ...f, from: from ?? null, to });
  }

  return {
    fields,
    // Dates the document printed that aren't real days, and a notice date the app worked out
    // rather than read. Both are things the landlord must be TOLD about — a figure silently
    // absent would read as "the new contract agrees with what's on file", the opposite of true.
    unusableDates,
    guessedDates: [],
    // Only when the derived date is actually a CHANGE. Deriving the same date already stored
    // is not news, and reporting it would make hasNoContractChanges() answer "there are
    // changes" for a document that says nothing new.
    noticeDerived: derivedNotice && fields.some((f) => f.key === 'notice_by_date') ? derivedNotice : null,
    // Whether the year's stored invoices have to be rebuilt afterwards — the §1 asymmetry: the
    // Financials breakdown and the Ledger rebuild from live data on their own, the invoice does not.
    touchesBilling: fields.some((f) => f.billed),
    feeSteps: plan?.steps?.length || 0,
    // Rows the document prints with no date the start could anchor — dropped, and said so
    // rather than let them vanish quietly.
    undatedSteps: plan?.undated || 0,
    // Rows whose basis can't be annualized (per_visit, unknown) — likewise named, never guessed.
    unusableSteps: plan?.unusable || 0,
  };
}

// Shift an ISO date by N days. Local-noon anchored, like every other date helper here, so a
// DST boundary can't roll the answer to the previous day.
function shiftDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The date written cancellation notice falls due: `end_date − notice_days`.
 *
 * ONE implementation, exported, because it has two callers — this module (so the review
 * dialog can show the date it is about to write) and updateServiceContract (so a contract
 * edited by hand on the Contracts tab gets the same date, and therefore the same reminder,
 * as one applied from a document). Two copies of this arithmetic would be a JS↔JS twin: the
 * alert would fire on one date and the screen would print another.
 *
 * Returns null unless both inputs are usable — a notice date must never be invented.
 */
export function noticeDueDate(endDate, noticeDays) {
  const end = text(endDate);
  const days = num(noticeDays);
  if (!end || !isoDateOrNull(end) || days === null || days <= 0) return null;
  return shiftDays(end, -days);
}

/**
 * What the contract WILL BE once `changes` is applied — the inputs the fee schedule has to be
 * built from. A field the document doesn't state keeps the contract's own value, so this is
 * not the same as reading the extraction.
 *
 * Shared by the review dialog and applyNewContractTerms so the schedule SHOWN and the schedule
 * WRITTEN are built from identical numbers. Two derivations of "the new fee" would drift the
 * first time either side changed.
 */
export function contractTargets(contract, changes) {
  const of = (key) => {
    const hit = (changes?.fields || []).find((f) => f.key === key);
    return hit ? hit.to : contract?.[key];
  };
  return {
    amount: num(of('amount')),
    frequency: of('frequency') || null,
    startDate: of('start_date') || null,
    endDate: of('end_date') || null,
    noticeDays: num(of('notice_days')),
    noticeByDate: of('notice_by_date') || null,
  };
}

// Nothing to apply at all — worth its own answer so the dialog can say "this document says the
// same as what's already on the contract" rather than showing an empty table.
// ⚠ The step counts and both date lists COUNT. A document whose only content is a fee table
// printed by contract year with no anchorable date would otherwise read as "nothing to
// update", so the dialog would offer Done and the warning naming those dropped rows would
// never render — the exact bug the lease side shipped and had to fix.
export const hasNoContractChanges = (changes) =>
  !changes
  || (changes.fields.length === 0 && !changes.feeSteps && !changes.undatedSteps
      && !changes.unusableSteps && !changes.noticeDerived
      && !(changes.guessedDates || []).length && !(changes.unusableDates || []).length);
