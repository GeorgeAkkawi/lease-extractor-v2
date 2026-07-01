// Assemble the full picture of a lease for the AI assistant: the app-computed CURRENT
// PHASE (authoritative today), the ORIGINAL LEASE text, and every AMENDMENT/RIDER in
// order. The original holds the complete base terms; riders add/override specifics; the
// current phase says where things actually stand now. Fed to ask-lease as `lease_text`.
import { fmtDate, money } from './format';
import { currentTermLabel } from './leaseTerm';

export function buildLeaseAskContext({ lease, renewals = [], addendums = [] } = {}) {
  if (!lease) return '';

  const pending = (renewals || []).filter((r) => r.status === 'pending');
  const pendingLines = pending.length
    ? pending.map((r) => {
        const rent = r.new_rent != null ? `${money(r.new_rent)}/yr`
          : r.annual_escalation_pct ? `+${r.annual_escalation_pct}%/yr`
          : 'rent per the option';
        const notice = r.notice_by_date ? `, notice by ${fmtDate(r.notice_by_date)}` : '';
        return `  - ${r.option_label || 'Renewal option'}: ${r.term_months || '?'} months at ${rent}${notice} — NOT yet exercised (pending the landlord's confirmation; it does not extend the committed term unless confirmed).`;
      }).join('\n')
    : '  - None pending.';

  const phase = [
    'CURRENT PHASE (computed by the app as of today — treat this as the authoritative current state):',
    `- Tenant: ${lease.tenant_name || '—'}${lease.tenant_contact_name ? ` (contact ${lease.tenant_contact_name})` : ''}`,
    `- Currently in: ${currentTermLabel(lease, renewals)}`,
    `- Committed term: ${fmtDate(lease.lease_start)} – ${fmtDate(lease.lease_termination_date)}`,
    `- Current annual base rent: ${money(lease.base_rent)}`,
    '- Pending renewal options:',
    pendingLines,
  ].join('\n');

  const amendments = (addendums || []).length
    ? (addendums || []).map((a) => {
        const head = `--- ${a.label || 'Amendment'} (dated ${fmtDate(a.amendment_date)}${a.kind ? `, ${a.kind}` : ''}) ---`;
        const body = [a.summary ? `Summary: ${a.summary}` : '', a.addendum_text || ''].filter(Boolean).join('\n');
        return body ? `${head}\n${body}` : head;
      }).join('\n\n')
    : 'None on record.';

  return [
    phase,
    '',
    'ORIGINAL LEASE:',
    lease.lease_text || '(no original lease text on file)',
    '',
    'AMENDMENTS / RIDERS (oldest first — a later one overrides earlier terms and the original where they conflict):',
    amendments,
  ].join('\n');
}
