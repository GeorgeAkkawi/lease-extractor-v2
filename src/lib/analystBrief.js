// The AI analyst's brief, as the review screens present it.
//
// A lease and a rider are both read by a Sonnet "analyst" pass before the cheap Haiku
// form-fillers run: it reads the whole document in prose (no schema cage) and ends with a
// machine-readable VERDICTS line the edge function parses. When a verdict says a term IS in
// the document but nothing landed on the form, the edge function flags the disagreement —
// the 2026-07-03 lesson that no model can output what the form can't hold.
//
// The labels below must stay in step with MISMATCH_LABELS in
// supabase/functions/_shared/analystVerdicts.js. They can't simply be imported: the app
// build can't reach across into supabase/functions, and the edge function can't reach into
// src/. Keeping ONE copy on this side (rather than one per review screen) at least means the
// lease and rider screens can't drift apart from each other.

// Strip the trailing machine-readable lines — "VERDICTS: …" and the red-flag "FLAGS: …"
// that follows it — so only the human-readable brief is shown. Both are parsed by the edge
// function before the brief is stored; on screen they're noise.
export function stripVerdicts(brief) {
  return String(brief)
    .replace(/\n*^\s*VERDICTS:.*$/im, '')
    .replace(/\n*^\s*FLAGS:.*$/im, '')
    .trimEnd();
}

export const MISMATCH_LABELS = {
  escalation: 'a rent escalation',
  renewal_options: 'a renewal or extension option',
  abatement: 'a free / reduced-rent (abatement) period',
  // rider-only codes
  rent_change: 'a change to the rent',
  term_extension: 'an extension of the term',
  assignment: 'an assignment to a new tenant',
  expense_estimate: 'a stated CAM / tax estimate',
};

// "a rent escalation and an extension of the term"
export function mismatchPhrase(codes) {
  return (Array.isArray(codes) ? codes : []).map((m) => MISMATCH_LABELS[m] || m).join(' and ');
}
