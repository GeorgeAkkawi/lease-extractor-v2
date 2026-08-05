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

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

// The lease's own columns, in the order a landlord reads them. `kind` is only a formatting
// hint for the table; nothing here depends on it.
//
// ⚠ tenant_name is NOT in this list. A new lease for the SAME tenant is the case George
// named, and a document that prints the trading name slightly differently ("Rose's Salon"
// vs "Roses Hair Salon LLC") would otherwise silently rename the tenant across every
// screen, every invoice and every email. Renaming a tenant stays a deliberate act.
const FIELDS = [
  { key: 'base_rent', label: 'Base rent', kind: 'money', billed: true },
  { key: 'square_footage', label: 'Square footage', kind: 'number', billed: true },
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
 * @param lease     the lease as it stands
 * @param proposed  the extraction normalised through initialFromExtraction (LeaseNewPage)
 * @param counts    { escalations, renewals, abatements } the new document's child rows
 * @returns { fields, touchesBilling, escalations, renewals, abatements }
 *
 * A field appears ONLY when the new document actually states something for it. A lease the
 * AI couldn't read a deposit out of must not blank the deposit already on file — silence in
 * a document is not an instruction to erase.
 */
export function newLeaseChanges(lease, proposed, counts = {}) {
  const fields = [];
  for (const f of FIELDS) {
    const to = proposed?.[f.key];
    const stated = NUMERIC.has(f.kind) ? num(to) !== null : text(to) !== '';
    if (!stated) continue;
    const from = lease?.[f.key];
    if (same(f.kind, from, to)) continue;
    fields.push({ ...f, from: from ?? null, to });
  }
  return {
    fields,
    // Whether the stored invoice has to be rebuilt afterwards — the asymmetry in §1: the
    // ledger and the breakdown rebuild from live data on their own, the invoice does not.
    touchesBilling: fields.some((f) => f.billed),
    escalations: Number(counts.escalations) || 0,
    renewals: Number(counts.renewals) || 0,
    abatements: Number(counts.abatements) || 0,
  };
}

// Nothing to apply at all — worth its own answer so the dialog can say "this document says
// the same as what's already on the lease" rather than showing an empty table.
export const hasNoChanges = (changes) =>
  !changes
  || (changes.fields.length === 0 && !changes.escalations && !changes.renewals && !changes.abatements);
