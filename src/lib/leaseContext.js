// Assemble the full picture of a lease for the AI assistant: the app-computed CURRENT
// PHASE (authoritative today), the ORIGINAL LEASE text, and every AMENDMENT/RIDER in
// order. The original holds the complete base terms; riders add/override specifics; the
// current phase says where things actually stand now. Fed to ask-lease as `lease_text`.
import { fmtDate, money } from './format';
import { currentPhase } from './leaseTerm';

export function buildLeaseAskContext({ lease, renewals = [], addendums = [], escalations = [] } = {}) {
  if (!lease) return '';
  const ph = currentPhase({ lease, escalations, renewals, addendums });

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
    `- Currently in: ${ph.label}`,
    `- Committed term: ${fmtDate(lease.lease_start)} – ${fmtDate(lease.lease_termination_date)}`,
    `- Current rent period: ${fmtDate(ph.phaseStart)} – ${fmtDate(ph.termEnd)}`,
    `- Current annual base rent: ${money(ph.rent)}`,
    ph.nextStep ? `- Next scheduled rent step: ${money(ph.nextStep.rent)} effective ${fmtDate(ph.nextStep.date)}` : null,
    '- Pending renewal options:',
    pendingLines,
  ].filter(Boolean).join('\n');

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
