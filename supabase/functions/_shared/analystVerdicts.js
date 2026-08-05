// Cross-checks the Sonnet "analyst read" against what the Haiku form-fillers actually
// captured, so a term the strong reader saw but the rigid form dropped raises a loud
// warning instead of a silent nothing. Pure + dependency-free so both Deno (edge) and
// Jest (frontend test) can import it.
//
// The analyst ends its brief with a single machine-readable line, e.g.
//   VERDICTS: escalation=yes; renewal_options=no; abatement=unclear; start_date=stated
// We parse that line, compare each yes/no against the extracted form, and return the
// mismatches (analyst said YES but the form is empty). Anything unclear/missing never
// flags — we only cry wolf when the analyst was affirmative and the form came up empty.

// Parse the VERDICTS line out of the analyst brief. Returns {} when the line is absent
// or unparseable (older briefs, an analyst that ignored the instruction, a timeout) — the
// caller then produces no mismatches and behavior is exactly as before.
export function parseAnalystVerdicts(brief) {
  if (!brief || typeof brief !== 'string') return {};
  // Take the LAST "VERDICTS:" occurrence (it's the closing line of the brief); tolerate
  // markdown bold/asterisks and any leading whitespace the model may add.
  const matches = [...brief.matchAll(/VERDICTS:\s*([^\n\r]*)/gi)];
  if (!matches.length) return {};
  const line = matches[matches.length - 1][1];
  const out = {};
  for (const pair of line.split(';')) {
    // Value can be a word (yes/no/unclear/stated) OR a number (escalation_pct=2,
    // escalation_stop_months=84) — capture up to the next space/semicolon either way.
    const m = pair.match(/([a-z_]+)\s*=\s*([^\s;]+)/i);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return out;
}

// True when the extracted escalations array holds at least one usable step (a dated step,
// a relative months_from_start step, or one carrying a rent/percent).
function hasEscalationSteps(escalations) {
  if (!Array.isArray(escalations)) return false;
  return escalations.some((e) => {
    if (!e || typeof e !== 'object') return false;
    return (
      e.effective_date != null ||
      e.months_from_start != null ||
      (e.new_base_rent != null && Number(e.new_base_rent) > 0) ||
      (e.escalation_value != null && Number(e.escalation_value) > 0)
    );
  });
}

function nonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

// Given the parsed verdicts + the extracted form, return an array of mismatch codes for
// every term the analyst affirmed (=yes) that the form failed to capture. Empty array =
// no disagreement (the common, healthy case). `extractionPct` covers the prose-formula
// path where the escalation lives as a percent rather than as discrete steps.
export function extractionMismatches({ verdicts, escalations, renewalOptions, abatements, escalationPct }) {
  const v = verdicts || {};
  const out = [];

  if (v.escalation === 'yes' && !hasEscalationSteps(escalations) && !(Number(escalationPct) > 0)) {
    out.push('escalation');
  }
  if (v.renewal_options === 'yes' && !nonEmptyArray(renewalOptions)) {
    out.push('renewal_options');
  }
  if (v.abatement === 'yes' && !nonEmptyArray(abatements)) {
    out.push('abatement');
  }
  return out;
}

// The same check for an ADDENDUM / rider. It can't reuse extractionMismatches: a rider's
// rent change usually lands on new_base_rent (a single new rent), not on an escalations
// array, so "the rent was captured" means something different here. A rider also has two
// effects a lease doesn't — an extension of the term and an assignment to a new tenant.
// Same discipline throughout: only an affirmative verdict with an empty form flags.
export function riderMismatches({
  verdicts, newBaseRent, escalations, newTerminationDate, renewalOptions, assignment, abatements, expenseEstimate,
}) {
  const v = verdicts || {};
  const out = [];

  const gotRent = (newBaseRent != null && Number(newBaseRent) > 0) || hasEscalationSteps(escalations);
  if (v.rent_change === 'yes' && !gotRent) out.push('rent_change');

  if (v.term_extension === 'yes' && !newTerminationDate) out.push('term_extension');
  if (v.renewal_options === 'yes' && !nonEmptyArray(renewalOptions)) out.push('renewal_options');
  // The assignment read returns null unless it's confident, so an analyst 'yes' against a
  // null assignment is exactly the disagreement worth surfacing.
  if (v.assignment === 'yes' && !(assignment && assignment.new_tenant_name)) out.push('assignment');
  if (v.abatement === 'yes' && !nonEmptyArray(abatements)) out.push('abatement');
  if (v.expense_estimate === 'yes' && !(expenseEstimate != null && Number(expenseEstimate) > 0)) out.push('expense_estimate');

  return out;
}

// The same check for a SERVICE CONTRACT. It can't reuse either of the two above: a
// contract has no rent and no tenant, and the terms that cost a landlord money here are a
// fee that grows, a fee schedule printed as a table, an agreement that renews itself, and
// the notice window that is the only way out of it. Same discipline: only an affirmative
// verdict against an empty form flags.
export function contractMismatches({ verdicts, feeSchedule, escalationPct, autoRenew, noticeDays, additionalInsured }) {
  const v = verdicts || {};
  const out = [];

  const gotEscalation = Number(escalationPct) > 0 || nonEmptyArray(feeSchedule);
  if (v.escalation === 'yes' && !gotEscalation) out.push('fee_escalation');

  if (v.fee_schedule === 'yes' && !nonEmptyArray(feeSchedule)) out.push('fee_schedule');

  // auto_renew is a tri-state on our side (true / false / unknown), so only an analyst
  // "yes" against a form that came back anything other than true is a disagreement.
  if (v.auto_renew === 'yes' && autoRenew !== true) out.push('auto_renew');

  // The analyst reports the window as a NUMBER of days ("cancellation_notice_days=30"), so
  // a positive figure there against an empty notice_days is the miss worth naming — this is
  // the deadline that costs money if nobody records it.
  const analystDays = Number(v.cancellation_notice_days);
  if (isFinite(analystDays) && analystDays > 0 && !(Number(noticeDays) > 0)) out.push('cancellation_notice');

  // 0094 — the analyst read an additional-insured requirement the form didn't record. Only
  // this direction is a "carries X that didn't land": the opposite case (form says the
  // requirement IS there, analyst says it isn't) is handled upstream, where a null form
  // answer simply takes the analyst's, so the two can only differ when both are definite.
  if (v.additional_insured === 'yes' && additionalInsured !== true) out.push('additional_insured');

  return out;
}

// Human-readable label per mismatch code, used by the review screens' warning text.
// Mirrored in src/lib/analystBrief.js (the app build can't import across into
// supabase/functions) — keep the two in step.
export const MISMATCH_LABELS = {
  escalation: 'a rent escalation',
  renewal_options: 'a renewal or extension option',
  abatement: 'a free / reduced-rent (abatement) period',
  // rider-only codes
  rent_change: 'a change to the rent',
  term_extension: 'an extension of the term',
  assignment: 'an assignment to a new tenant',
  expense_estimate: 'a stated CAM / tax estimate',
  // service-contract-only codes
  fee_escalation: 'an increase in the fee',
  fee_schedule: 'a printed fee schedule',
  auto_renew: 'an automatic renewal',
  cancellation_notice: 'a cancellation-notice period',
  additional_insured: 'a requirement to name you as additional insured',
};
