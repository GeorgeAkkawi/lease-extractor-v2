// The landlord-side red-flag checklist: terms a commercial lease is MISSING, or carries,
// that tend to cost the landlord later. Pure + dependency-free so both Deno (the edge
// functions) and Vitest (the frontend suite) can import it.
//
// Why a fixed checklist rather than free-form advice: the model is already reading every
// page during the analyst pass, so answering ten known questions costs a line of output
// (~+1¢ on a read already paid for) and produces something the app can store, badge, and
// compare between leases. Free prose would cost more and be un-renderable.
//
// One convention throughout, and the prompt says it twice: **yes = the concern applies.**
// Every key is phrased so "yes" is the answer the landlord should look at — `no_late_fee`
// yes means there is no late fee, `cam_capped` yes means CAM is capped. no/unclear never
// raise a flag: this is a prompt to go look, never an accusation, and a lease that simply
// wasn't read clearly should stay quiet rather than invent a problem.
//
// This is NOT legal advice, and the UI says so. It's a reading aid.

export const LEASE_FLAG_DEFS = [
  {
    key: 'no_personal_guarantee',
    severity: 'high',
    title: 'No personal guarantee',
    note: 'The lease is signed by the business only. If the entity folds or stops paying, there is no individual to pursue for the balance — a personal guarantee from an owner is the usual protection.',
  },
  {
    key: 'no_security_deposit',
    severity: 'high',
    title: 'No security deposit',
    note: 'Nothing is held against unpaid rent or damage at move-out. Most commercial leases hold one to three months.',
  },
  {
    key: 'tenant_early_termination',
    severity: 'high',
    title: 'Tenant can end the lease early',
    note: 'The tenant has a right to terminate before the term ends. Check what notice and termination fee it requires — this is the term most likely to cut the income you are counting on.',
  },
  {
    key: 'no_assignment_consent',
    severity: 'high',
    title: 'Tenant may assign without your consent',
    note: 'The lease lets the tenant transfer it (or sublet) without the landlord approving who takes over. You could end up with a tenant you never agreed to.',
  },
  {
    key: 'cam_capped',
    severity: 'medium',
    title: 'CAM / operating expenses are capped',
    note: 'The tenant’s share of common-area costs is limited. Any increase above the cap is absorbed by you, not recovered — worth pricing in before you renew.',
  },
  {
    key: 'no_late_fee',
    severity: 'medium',
    title: 'No late fee or interest on late rent',
    note: 'Nothing in the lease penalises paying late, so there is little cost to the tenant in doing so.',
  },
  {
    key: 'no_holdover_premium',
    severity: 'medium',
    title: 'No holdover premium',
    note: 'If the tenant stays past the term, the rent does not step up. A holdover clause (commonly 150–200% of base rent) is what gets the space back or gets it paid for.',
  },
  {
    key: 'no_insurance_requirements',
    severity: 'medium',
    title: 'No insurance requirement',
    note: 'The lease does not require the tenant to carry liability insurance or name you as an additional insured, so a claim arising from their operations can land on your policy.',
  },
  {
    key: 'below_market_renewal',
    severity: 'medium',
    title: 'Renewal rent is fixed, not market',
    note: 'A renewal option prices the next term at a set figure or a small fixed step rather than fair market value. If the market moves, the tenant holds the upside.',
  },
  {
    key: 'exclusive_use',
    severity: 'info',
    title: 'Exclusive-use clause',
    note: 'The tenant has the exclusive right to their use at this property, which limits who you can lease the other spaces to. Worth knowing before you sign the next tenant.',
  },
];

const BY_KEY = Object.fromEntries(LEASE_FLAG_DEFS.map((d) => [d.key, d]));
const SEVERITIES = new Set(['high', 'medium', 'info']);
// Most severe first, so the strip reads top-down in the order a landlord should care.
const RANK = { high: 0, medium: 1, info: 2 };

// The instruction block appended to the analyst prompt (extract-lease) and used whole by
// review-lease. Kept here so the two readers ask the identical question — a flag raised at
// import and the same flag raised by the review button must mean the same thing.
//
// ⚠ THE PARSER IS SHARED, THE VOCABULARY IS NOT. Every function below takes an optional
// `defs` argument defaulting to LEASE_FLAG_DEFS, so a service contract (CONTRACT_FLAG_DEFS,
// ../_shared/contractFlags.js) reuses this exact engine rather than growing a second copy
// of it. Defaulting the argument is what keeps the lease path byte-for-byte unchanged —
// every existing call site still reads the lease definitions with no edit.
export function flagInstructionFor(defs, questionFn, subject = 'lease') {
  return (
    'RED FLAGS / MISSING PROTECTIONS — read the ' + subject + ' as the LANDLORD\'S advisor and ' +
    'answer each of the checks below. Answer yes ONLY when you are confident from the document; ' +
    'answer no when the ' + subject + ' clearly addresses it; answer unclear when you cannot tell. ' +
    'Never guess — an unclear is far better than a wrong yes.\n' +
    'In every check, **yes means the concern APPLIES**:\n' +
    defs.map((d) => `  ${d.key} = yes if ${questionFn(d.key)}`).join('\n')
  );
}

export const LEASE_FLAG_INSTRUCTION = flagInstructionFor(LEASE_FLAG_DEFS, flagQuestion, 'lease');

// The one-line test behind each key, phrased so "yes" is always the concern.
function flagQuestion(key) {
  switch (key) {
    case 'no_personal_guarantee': return 'NO personal guarantee or guarantor is given by an individual (the business alone is on the hook)';
    case 'no_security_deposit': return 'NO security deposit is required';
    case 'tenant_early_termination': return 'the TENANT has a right to terminate early (a cancellation / kick-out / co-tenancy or go-dark right)';
    case 'no_assignment_consent': return 'the tenant may assign or sublet WITHOUT the landlord\'s prior consent (or consent is deemed given automatically)';
    case 'cam_capped': return 'the tenant\'s CAM / operating-expense share is CAPPED or limited to a percentage increase';
    case 'no_late_fee': return 'there is NO late fee or interest charged on late rent';
    case 'no_holdover_premium': return 'holdover rent is NOT increased above the normal rent (or holdover is not addressed)';
    case 'no_insurance_requirements': return 'the tenant is NOT required to carry liability insurance (or not required to name the landlord as additional insured)';
    case 'below_market_renewal': return 'a renewal option sets the rent at a FIXED figure or small fixed step rather than fair market value';
    case 'exclusive_use': return 'the tenant is granted an EXCLUSIVE use / non-compete right restricting who else the landlord may lease to';
    default: return 'the concern applies';
  }
}

// The exact machine-readable line the readers must end with.
export const flagLineSpecFor = (defs) =>
  'FLAGS: ' + defs.map((d) => `${d.key}=<yes|no|unclear>`).join('; ');

export const LEASE_FLAG_LINE_SPEC = flagLineSpecFor(LEASE_FLAG_DEFS);

// Pull the FLAGS line out of an analyst brief. Same discipline as parseAnalystVerdicts:
// take the LAST occurrence (it's a closing line), tolerate markdown and stray whitespace,
// and return {} when absent so an older brief or a timed-out analyst simply produces no
// flags rather than an error.
export function parseAnalystFlags(brief) {
  if (!brief || typeof brief !== 'string') return {};
  const matches = [...brief.matchAll(/FLAGS:\s*([^\n\r]*)/gi)];
  if (!matches.length) return {};
  const line = matches[matches.length - 1][1];
  const out = {};
  for (const pair of line.split(';')) {
    const m = pair.match(/([a-z_]+)\s*=\s*([^\s;]+)/i);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase().replace(/[^a-z]/g, '');
  }
  return out;
}

// Turn parsed verdicts into the canonical flag list — only the keys we know, only the
// ones answered "yes". Severity/title/note come from the definitions, never from the
// model, so wording stays consistent across leases and can be improved in one place.
export function flagsFromVerdicts(verdicts, defs = LEASE_FLAG_DEFS) {
  const v = verdicts || {};
  return defs
    .filter((d) => v[d.key] === 'yes')
    .map((d) => ({ key: d.key, severity: d.severity, title: d.title, note: d.note, quote: null }));
}

// Normalize whatever a reader returned into the stored shape: known keys only, one entry
// per key, our own title/note/severity, the model's supporting quote kept when it gave
// one. Anything malformed is dropped rather than stored — this blob is rendered directly.
export function normalizeReviewFlags(raw, defs = LEASE_FLAG_DEFS) {
  const byKey = defs === LEASE_FLAG_DEFS ? BY_KEY : Object.fromEntries(defs.map((d) => [d.key, d]));
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    const key = String(f?.key || '').toLowerCase().trim();
    const def = byKey[key];
    if (!def || seen.has(key)) continue;
    // A reader may downgrade to 'info' on a soft finding; it may never invent a severity.
    const sev = SEVERITIES.has(String(f?.severity)) ? String(f.severity) : def.severity;
    seen.add(key);
    out.push({
      key,
      severity: sev,
      title: def.title,
      note: def.note,
      quote: f?.quote ? String(f.quote).slice(0, 400) : null,
    });
  }
  return out.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));
}

// The stored blob every writer produces: leases.ai_review, and — with CONTRACT_FLAG_DEFS
// passed as `defs` — service_contracts.ai_review.
export function buildReviewRecord({ flags, model, source, reviewedAt, defs = LEASE_FLAG_DEFS }) {
  return {
    flags: normalizeReviewFlags(flags, defs),
    model: model || null,
    source: source || null,
    reviewed_at: reviewedAt || new Date().toISOString(),
  };
}
