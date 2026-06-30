// Full, professional tenant-email drafts (renewal + rent-escalation notices).
// Letter-style: business letterhead, dated, addressed To the tenant contact +
// business + property, an RE: line, body, and a signature block. All text is
// generated in code (no AI cost). Invoices are handled separately (the
// draft-invoice edge function / demo fallback) but follow the same shape.
import { money } from './format';

const longDate = (iso) => {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};
const today = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const monthlyOf = (annual) => (annual ? money(Math.round(Number(annual) / 12)) : null);

// Shared letter scaffold: header → date → To block → RE → body → signature.
function letter({ business, toBlock, reLine, paragraphs }) {
  const contact = [business?.contact_email, business?.contact_phone].filter(Boolean).join(' · ');
  const out = [];
  [business?.company_name, business?.address, contact].filter(Boolean).forEach((l) => out.push(l));
  if (out.length) out.push('');
  out.push(today(), '');
  (toBlock || []).filter(Boolean).forEach((l) => out.push(l));
  if (toBlock?.some(Boolean)) out.push('');
  if (reLine) out.push(reLine, '');
  paragraphs.filter((p) => p != null).forEach((p) => out.push(p, ''));
  out.push('Sincerely,', business?.company_name || 'Property Management');
  if (contact) out.push(contact);
  return out.join('\n');
}

function toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }) {
  return [
    contact_name || tenant_name,
    contact_name && tenant_name && contact_name !== tenant_name ? tenant_name : null,
    propertyName ? `Tenant at ${propertyName}` : null,
    tenant_email || null,
  ];
}

export function buildRenewalEmail({ business, tenant_name, contact_name, tenant_email, propertyName, newStart, newEnd, oldRent, newRent }) {
  const monthly = monthlyOf(newRent);
  const changed = oldRent != null && newRent != null && Number(newRent) !== Number(oldRent);
  const subject = `Lease Renewal Confirmation — ${propertyName || 'your premises'} (effective ${longDate(newStart)})`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Renewal of your lease at ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `We are pleased to confirm that the lease for ${tenant_name || 'your business'} at ${propertyName || 'the premises'} has been renewed. The renewed term begins ${longDate(newStart)} and continues through ${longDate(newEnd)}.`,
      `Effective ${longDate(newStart)}, the annual base rent for the renewed term is ${money(newRent)}${monthly ? ` (${monthly} per month)` : ''}${changed ? `, adjusted from the prior rate of ${money(oldRent)} per year` : ''}. Please update your records and remit the new amount beginning with the first payment of the renewed term. All other terms and conditions of the lease remain in full force and effect.`,
      `If you have any questions regarding the renewal or the updated rent, please don't hesitate to contact our office. We appreciate your continued tenancy and look forward to another successful term.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}

// Asks the tenant for a current certificate of insurance naming the landlord as
// additional insured (as required by the lease), to keep on file.
export function buildInsuranceRequestEmail({ business, tenant_name, contact_name, tenant_email, propertyName }) {
  const company = business?.company_name || 'the landlord';
  const subject = `Certificate of Insurance Request — ${propertyName || 'your premises'}`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Certificate of insurance for ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `As required under the insurance provisions of your lease at ${propertyName || 'the premises'}, please provide a current certificate of insurance (COI) for our files.`,
      `Kindly ensure the certificate names ${company} as an additional insured, and confirm the policy is active with the coverage limits required by the lease. If a renewed certificate has been issued, please send the updated copy so our records stay current.`,
      `You can reply to this email with the certificate attached, or have your insurance agent send it directly to our office. Thank you for your prompt attention — please let us know if you have any questions.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}

export function buildEscalationEmail({ business, tenant_name, contact_name, tenant_email, propertyName, effectiveDate, priorRent, newRent, escalationType, escalationValue }) {
  const monthly = monthlyOf(newRent);
  const delta =
    escalationType === 'percent' ? `an increase of ${escalationValue}%`
    : escalationType === 'fixed' ? `a scheduled increase of ${money(escalationValue)}`
    : escalationType === 'cpi' ? `a CPI-based adjustment of ${escalationValue}%`
    : 'a scheduled adjustment';
  const subject = `Rent Adjustment Notice — ${propertyName || 'your premises'} (effective ${longDate(effectiveDate)})`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Scheduled rent adjustment at ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `This letter serves as formal notice that, pursuant to the rent-escalation provisions of your lease at ${propertyName || 'the premises'}, your base rent will be adjusted effective ${longDate(effectiveDate)}.`,
      `The annual base rent will change from ${money(priorRent)} to ${money(newRent)}${monthly ? ` (${monthly} per month)` : ''}, reflecting ${delta} as provided for in the lease. Please arrange for the updated amount to be remitted beginning with the payment due on or after the effective date.`,
      `All other terms of the lease remain unchanged. Should you have any questions about this adjustment, please contact our office and we will be glad to assist.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}
