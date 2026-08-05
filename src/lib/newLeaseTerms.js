// What a newly-uploaded lease document would CHANGE on the lease it replaces.
//
// George, 2026-08-04: *"well if i replace a lease with a new one id want the figures to
// change based on the new lease thats the point so it should say 'upload new lease'."*
//
// The first cut swapped the file and re-read the text but deliberately left every figure
// alone. That was the wrong call: a new lease IS new terms, and leaving the old rent on a
// lease whose document says something else is worse than either option — the app would show
// one number and the document beside it would say another.
//
// So this computes the diff and the UI shows it BEFORE anything is written, because these
// are billed figures: base rent and square footage feed the invoice, the ledger and the
// tenant's share of CAM (CLAUDE.md §1). "The figures change" must never mean "the figures
// changed and nobody said which".
//
// Pure on purpose — no supabase, no React. The apply step (applyNewLeaseTerms, api.js) does
// the writing and the billing carry-through; this only decides what is different.

import { isoDateOrNull } from './isoDate';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The AI returns every field as { value, confidence, source_quote, page }; a few (lease_type)
// come back as a bare string off the analyst's VERDICTS line. Read either shape.
const val = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

// The lease's own columns, in the order a landlord reads them. `kind` is only a formatting
// hint for the table; nothing here depends on it. `billed` marks the figures that a stored
// invoice was built from — see touchesBilling below.
//
// ⚠ tenant_name is NOT in this list. A new lease for the SAME tenant is the case George
// named, and a document that prints the trading name slightly differently ("Rose's Salon"
// vs "Roses Hair Salon LLC") would otherwise silently rename the tenant across every
// screen, every invoice and every email. Renaming a tenant stays a deliberate act.
const FIELDS = [
  { key: 'base_rent', label: 'Base rent', kind: 'money', billed: true },
  { key: 'square_footage', label: 'Square footage', kind: 'number', billed: true },
  // The combined CAM & tax estimate. It is what the tenant is billed all year (the actual
  // only settles it at ⚖ Reconcile), so a new lease that prices it and is applied without
  // it would bill the OLD document's estimate against the new document's rent.
  { key: 'est_cam_annual', label: 'CAM & tax estimate', kind: 'money', billed: true, combined: true },
  // Gross vs net decides whether CAM / tax / roof are added ON TOP of rent or carved OUT of
  // it (billedComponents → resyncYearBillingToEstimate). Getting it wrong is a whole-invoice
  // error, not a cosmetic one.
  { key: 'lease_type', label: 'Lease type', kind: 'text', billed: true },
  { key: 'lease_start', label: 'Lease start', kind: 'date', billed: true },
  { key: 'lease_termination_date', label: 'Lease end', kind: 'date', billed: true },
  { key: 'security_deposit', label: 'Security deposit', kind: 'money' },
  { key: 'premises_address', label: 'Premises', kind: 'text' },
  { key: 'tenant_contact_name', label: 'Contact', kind: 'text' },
  { key: 'tenant_email', label: 'Tenant email', kind: 'text' },
  { key: 'lease_terms', label: 'Terms', kind: 'text' },
];

const NUMERIC = new Set(['money', 'number']);

// Two values are "the same" when they mean the same thing, not when they look it: 84000 and
// "84000.00" are one figure, and a blank is a blank however it is spelled.
function same(kind, a, b) {
  if (NUMERIC.has(kind)) {
    const x = num(a); const y = num(b);
    if (x === null && y === null) return true;
    return x !== null && y !== null && Math.abs(x - y) < 0.005;
  }
  return text(a) === text(b);
}

/**
 * The CAM & tax estimate a document states, as ONE annual figure.
 *
 * The app bills a single merged estimate — the combined figure on `est_cam_annual` with
 * `est_tax_annual` zeroed — and every surface that reads it sums the two anyway. The AI
 * reports CAM and tax separately (a lease usually prints them separately), so they are
 * added here, in the one place, rather than at each reader.
 *
 * Returns null when the document prices neither — and ALSO when it prices both at zero.
 * That second case is deliberate, not an oversight the docstring used to paper over: the AI
 * returns `value: null` for a figure it couldn't find, so a literal 0 is far likelier to be a
 * misread than a lease genuinely stating no CAM at all — and treating it as real would zero a
 * tenant's whole CAM & tax billing off one bad read. A lease that truly carries none is
 * entered by hand, deliberately, on the lease page.
 */
export function statedCamTaxAnnual(extraction) {
  const read = (k) => num(val(extraction?.[k]));
  const cam = read('est_cam_annual');
  const tax = read('est_tax_annual');
  if (cam === null && tax === null) return null;
  const total = (cam || 0) + (tax || 0);
  return total > 0 ? round2(total) : null;
}

// The same merge on the lease side, so the from→to comparison is like for like. A lease
// holding NO estimate returns null, not 0 — the diff's "Now" column must read "—" rather
// than "$0.00", which would claim someone had entered a zero.
export function leaseCamTaxAnnual(lease) {
  const cam = num(lease?.est_cam_annual);
  const tax = num(lease?.est_tax_annual);
  if (cam === null && tax === null) return null;
  return (cam || 0) + (tax || 0);
}

/**
 * Per-field confidence from an AI read, for the badges on the lease page. Lives here rather
 * than beside the intake form because BOTH the new-tenant import and a replacement document
 * store it — and a badge left over from the previous document is a badge describing a file
 * that is no longer on the lease.
 */
export function buildAiConfidence(ex) {
  const map = {};
  ['tenant_name', 'tenant_contact_name', 'tenant_email', 'premises_address', 'square_footage',
    'base_rent', 'lease_start', 'lease_termination_date', 'lease_terms', 'est_cam_annual',
    'est_tax_annual', 'security_deposit'].forEach((f) => {
    if (ex?.[f] && ex[f].confidence != null) map[f] = ex[f].confidence;
  });
  return Object.keys(map).length ? map : null;
}

/**
 * @param lease       the lease as it stands
 * @param proposed    the extraction normalised through initialFromExtraction (LeaseNewPage)
 * @param extraction  the raw AI read, for the figures initialFromExtraction reshapes for the form
 * @param plan        buildScheduleFromExtraction's output — the rows that would actually be
 *                    written, NOT the raw counts. A lease-year step the document prints with
 *                    no date can't be scheduled, and promising one that never lands is worse
 *                    than saying so.
 * @returns { fields, touchesBilling, escalations, renewals, abatements, optionSteps, undated }
 *
 * A field appears ONLY when the new document actually states something for it. A lease the
 * AI couldn't read a deposit out of must not blank the deposit already on file — silence in
 * a document is not an instruction to erase.
 */
export function newLeaseChanges({ lease, proposed, extraction = null, plan = null } = {}) {
  const stated = {
    ...(proposed || {}),
    // Not on the form's shape: the form holds a $/SF rate and multiplies at save, but the
    // lease column is annual dollars, so compare annuals.
    est_cam_annual: statedCamTaxAnnual(extraction),
  };
  // ── DATES THE DOCUMENT DIDN'T PRINT ───────────────────────────────────────────────────
  // `proposed` comes from initialFromExtraction, which is written for the new-tenant INTAKE
  // FORM: when a lease prints no commencement date (common — it's often a formula, "120 days
  // after delivery"), it falls back to the SIGNING date, and derives the end from start +
  // term. Its own comment calls those "SUGGESTED, editable" — true on a form the landlord
  // then edits, false here, where the review is a read-only table with no fields.
  //
  // George, 2026-08-05, asked what this dialog should do: **don't apply a guessed date at
  // all.** So they are dropped, and reported so the dialog can say which and why. This is
  // not fussiness — lease_start becomes boundaryIso in applyNewLeaseTerms, the date the whole
  // rent-era and estimate-era split hangs off, and moving it forward is what takes the
  // earlier months out of term.
  const guessedDates = [];
  if (text(stated.lease_start) !== '' && text(val(extraction?.lease_start)) === '') {
    guessedDates.push({ key: 'lease_start', label: 'Lease start', from: 'the signing date', value: stated.lease_start });
    delete stated.lease_start;
  }
  if (text(stated.lease_termination_date) !== '' && text(val(extraction?.lease_termination_date)) === '') {
    guessedDates.push({ key: 'lease_termination_date', label: 'Lease end', from: 'the stated term length', value: stated.lease_termination_date });
    delete stated.lease_termination_date;
  }
  // ── DATES THAT AREN'T REAL DAYS ───────────────────────────────────────────────────────
  // A date field goes into the patch verbatim and straight into a Postgres `date` column, so
  // "2033-04-31" — which models really do return, and which V8 parses happily by rolling to
  // May 1 — fails the ENTIRE apply with `date/time field value out of range`. There are no
  // fields in this dialog to correct it in, so the lease simply could not be applied at all.
  // Drop the unusable value, keep the rest of the document, and name what was printed.
  const unusableDates = [];
  for (const f of FIELDS) {
    if (f.kind !== 'date') continue;
    const raw = stated[f.key];
    if (text(raw) === '' || isoDateOrNull(String(raw).trim())) continue;
    unusableDates.push({ key: f.key, label: f.label, printed: String(raw) });
    delete stated[f.key];
  }
  const fields = [];
  for (const f of FIELDS) {
    const to = stated[f.key];
    const says = NUMERIC.has(f.kind) ? num(to) !== null : text(to) !== '';
    if (!says) continue;
    // A stored null lease_type MEANS net (migration 0073), so a document read as net must
    // not present itself as a change against it — that would put a row in the table every
    // single time an ordinary NNN lease is re-uploaded.
    const from = f.key === 'est_cam_annual' ? leaseCamTaxAnnual(lease)
      : f.key === 'lease_type' ? (lease?.lease_type || 'net')
        : lease?.[f.key];
    if (same(f.kind, from, to)) continue;
    fields.push({ ...f, from: from ?? null, to });
  }
  return {
    fields,
    // Dates the document didn't print, and dates it printed that aren't real days. Both are
    // things the landlord must be TOLD about — a figure silently absent from the table would
    // read as "the new lease agrees with what's on file", which is the opposite of the truth.
    guessedDates,
    unusableDates,
    // Whether the stored invoice has to be rebuilt afterwards — the asymmetry in §1: the
    // ledger and the breakdown rebuild from live data on their own, the invoice does not.
    touchesBilling: fields.some((f) => f.billed),
    escalations: plan?.escalations?.length || 0,
    renewals: plan?.renewals?.length || 0,
    abatements: plan?.abatements?.length || 0,
    optionSteps: plan?.optionSteps?.length || 0,
    // Steps the document prints by lease year with no date the lease start could anchor —
    // they are dropped, and the dialog says so rather than letting them vanish quietly.
    undated: plan?.undated || 0,
  };
}

/**
 * What the lease WILL BE once `changes` is applied — the inputs the rent schedule has to be
 * built from. A field the document doesn't state keeps the lease's own value, so this is not
 * the same as reading the extraction.
 *
 * Shared by the review dialog and applyNewLeaseTerms so the schedule shown and the schedule
 * written are built from identical numbers. Two derivations of "the new base rent" would
 * drift the first time either side changed.
 */
export function newLeaseTargets(lease, changes) {
  const of = (key) => {
    const hit = (changes?.fields || []).find((f) => f.key === key);
    return hit ? hit.to : lease?.[key];
  };
  return {
    baseRent: num(of('base_rent')) ?? 0,
    leaseStart: of('lease_start') || null,
    termEnd: of('lease_termination_date') || null,
  };
}

// Nothing to apply at all — worth its own answer so the dialog can say "this document says
// the same as what's already on the lease" rather than showing an empty table.
// ⚠ `undated` counts. A document whose only content is a rent table printed by lease year
// with no date the lease start can place used to read as "nothing to update" — so the dialog
// offered Done and the warning naming those dropped steps never rendered at all.
export const hasNoChanges = (changes) =>
  !changes
  || (changes.fields.length === 0 && !changes.escalations && !changes.renewals
      && !changes.abatements && !changes.optionSteps && !changes.undated
      && !(changes.guessedDates || []).length && !(changes.unusableDates || []).length);
