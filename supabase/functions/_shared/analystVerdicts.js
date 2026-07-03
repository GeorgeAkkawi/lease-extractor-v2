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
    const m = pair.match(/([a-z_]+)\s*=\s*([a-z_]+)/i);
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

// Human-readable label per mismatch code, used by the review screen's warning text.
export const MISMATCH_LABELS = {
  escalation: 'a rent escalation',
  renewal_options: 'a renewal or extension option',
  abatement: 'a free / reduced-rent (abatement) period',
};
