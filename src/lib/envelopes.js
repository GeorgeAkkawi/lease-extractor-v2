import { fmtDate } from './format';

// E-signature envelopes — the small shared rules about where a document sent for signature
// currently stands. Four surfaces have to agree about that (the Addendums & riders card, the
// dashboard alert, the History timeline, and the public signing page itself), so the wording
// and the state machine live here rather than in four components.
//
// ⚠ THE STORED STATUS IS NOT THE WHOLE ANSWER. An envelope that was sent and then quietly ran
// past its expiry still holds status 'sent' in the database — nothing sweeps it, deliberately
// (a nightly cron that rewrote rows would be one more thing to keep correct, and the date is
// already on the row). `envelopeStatus` is therefore the ONLY thing that should be read for a
// decision; a bare `env.status` will tell you a dead link is live. The edge function applies
// the identical rule server-side, which is what actually refuses the document — this is the
// client's mirror of it, and the two must move together.

export const DEFAULT_EXPIRY_DAYS = 30;

// How long a signing link stays alive, offered when sending. Anything longer than a quarter
// stops being a deadline and starts being an unguarded bearer token lying in an inbox.
export const EXPIRY_CHOICES = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
];

// What the document IS. This is the one field that decides where an executed copy files
// itself, so it is asked plainly when sending rather than guessed from the filename.
export const PURPOSE = [
  {
    key: 'extension',
    label: 'An extension or amendment',
    hint: 'A rider that extends the term, changes the rent, or adds an option. Once signed it files itself under Addendums & riders.',
  },
  {
    key: 'new_lease',
    label: 'A replacement lease',
    hint: 'A whole new lease for this space. Once signed you choose whether it updates this tenant’s record or replaces it.',
  },
  {
    key: 'other',
    label: 'Something else',
    hint: 'An estoppel, a consent, a notice — anything that needs a signature but changes no lease term. Filed as a rider with no changes applied.',
  },
];

export const purposeLabel = (key) => PURPOSE.find((p) => p.key === key)?.label || 'Document';

// An ISO timestamp N days from `now`, for the expiry picker. Kept here so the modal and the
// tests price a "30 day" link the same way.
export function expiryFromNow(days, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + (Number(days) || DEFAULT_EXPIRY_DAYS));
  return d.toISOString();
}

// The REAL state of an envelope. Only 'sent' can decay — a signed envelope is waiting on the
// landlord and an expiry can't take that away from the tenant who already signed it, and the
// three terminal states are settled records.
export function envelopeStatus(env, now = Date.now()) {
  if (!env) return 'voided';
  if (env.status !== 'sent') return env.status;
  const ends = env.expires_at ? new Date(env.expires_at).getTime() : null;
  return ends && ends <= now ? 'expired' : 'sent';
}

// Is this envelope still going anywhere? Drives whether the row offers Void/Resend and
// whether the dashboard raises it.
export const isOpen = (env, now) => ['sent', 'signed'].includes(envelopeStatus(env, now));

// Waiting on the LANDLORD, which is the only state he can clear himself — and therefore the
// only one worth an alert that says "do this".
export const needsCountersign = (env, now) => envelopeStatus(env, now) === 'signed';

// Executed and not yet pushed into the lease. `applied_at` is written by the Phase 2 apply
// step; until then an executed envelope is a signed document sitting in a drawer.
export const needsApply = (env, now) =>
  envelopeStatus(env, now) === 'executed' && !env?.applied_at;

// Badge tone + label, matching the vocabulary the renewal-options table already uses
// (good / warn / danger / info) so the two tables read as one system.
export function statusBadge(env, now) {
  switch (envelopeStatus(env, now)) {
    case 'signed':
      return { cls: 'warn', label: 'Signed — countersign', title: 'The tenant has signed. Add your signature to execute it.' };
    case 'executed':
      return { cls: 'good', label: 'Executed', title: 'Signed by both parties.' };
    case 'declined':
      return { cls: 'danger', label: 'Declined', title: 'The tenant declined to sign.' };
    case 'voided':
      return { cls: 'info', label: 'Voided', title: 'Cancelled — the link no longer works.' };
    case 'expired':
      return { cls: 'info', label: 'Expired', title: 'The signing link passed its expiry date and no longer opens.' };
    default:
      // NOT "Out for signature" — that is the strip's own heading, and a badge repeating it
      // told the landlord nothing he couldn't already see. Naming who it is waiting on is
      // the useful half, and it reads as the counterpart to "Signed — countersign".
      return { cls: 'warn', label: 'Awaiting tenant', title: 'Sent and waiting on the tenant.' };
  }
}

// Days left before the link stops working — negative once it has. Null when there is no
// expiry to count toward, so callers can tell "none" from "zero".
export function daysToExpiry(env, now = Date.now()) {
  if (!env?.expires_at) return null;
  const ms = new Date(env.expires_at).getTime() - now;
  return Math.ceil(ms / 86400000);
}

// The one-line detail under an envelope's title. Says who it is with, and — while it is
// still live — how long the link has. "Expires in 2 days" is the part that actually
// prompts a chase; a bare date does not.
export function envelopeLine(env, now = Date.now()) {
  const who = env?.signer_name || 'the tenant';
  const state = envelopeStatus(env, now);
  if (state === 'sent') {
    const left = daysToExpiry(env, now);
    const when = left == null ? '' :
      left <= 0 ? ' · expires today' :
      left === 1 ? ' · expires tomorrow' :
      left <= 7 ? ` · expires in ${left} days` :
      ` · expires ${fmtDate(env.expires_at)}`;
    return `Waiting on ${who} · sent ${fmtDate(env.sent_at)}${when}`;
  }
  if (state === 'expired') return `${who} never signed · link expired ${fmtDate(env.expires_at)}`;
  if (state === 'signed') return `${who} signed ${fmtDate(env.signed_at)} · waiting on your signature`;
  if (state === 'executed') return `Signed by both parties ${fmtDate(env.executed_at)}`;
  if (state === 'declined') return `${who} declined ${fmtDate(env.signed_at || env.updated_at)}`;
  return `Cancelled ${fmtDate(env.updated_at)}`;
}

// Newest first — an envelope list is a "what's happening now" list, the opposite of the
// riders below it (which read oldest-first to walk the lease forward through time).
export function sortEnvelopes(envs) {
  return [...(envs || [])].sort((a, b) => String(b?.sent_at || '').localeCompare(String(a?.sent_at || '')));
}

// Can the landlord still pull this back?
//
// Widened on 2026-08-04 to include 'signed'. The original rule allowed only 'sent', reasoning
// that voiding after a signature destroys a record of something that genuinely happened — but
// that left a signed envelope PERMANENTLY stuck on the lease card with no way off it, which
// George hit within an hour of shipping on a test run. Voiding a signed envelope keeps the
// row and its whole signature record; it only withdraws the document and kills the link. The
// dialog says which of the two is happening.
export const canVoid = (env, now) => ['sent', 'signed'].includes(envelopeStatus(env, now));

// Delete is available on ANY status — including executed. It is the landlord's own document
// and a test run has to be removable, so the answer is not "never", it is "say exactly what
// is lost first". Deleting an EXECUTED envelope destroys a signed legal document along with
// its audit trail, so the confirm is graded by status rather than being one generic warning.
export const canDelete = () => true;

// How stern the delete dialog has to be. 'record' = a signature exists and would be
// destroyed; 'executed' = a fully signed document would be.
export function deleteSeverity(env, now) {
  const s = envelopeStatus(env, now);
  if (s === 'executed') return 'executed';
  if (s === 'signed' || s === 'declined') return 'record';
  return 'plain';
}

// Re-sending mints a NEW token and retires the old one (see send-for-signature), so it is
// also the fix for an expired link — which is why 'expired' is offered here and 'sent' is
// too (the tenant lost the email).
export const canResend = (env, now) => ['sent', 'expired'].includes(envelopeStatus(env, now));
