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

// Heads-up sent BEFORE the renewal decision: the current term is approaching its end
// and a renewal option is available. Invites the tenant to say whether they intend to
// renew (by the notice-by date, if the lease states one). Does not commit anything.
export function buildRenewalApproachingEmail({ business, tenant_name, contact_name, tenant_email, propertyName, termEnd, optionLabel, termMonths, newRent, escalationPct, noticeByDate }) {
  const years = termMonths ? Math.round(termMonths / 12) : null;
  const termPhrase = years ? (years === 1 ? 'a one-year renewal term' : `a ${years}-year renewal term`) : 'a renewal term';
  const rentPhrase =
    newRent != null ? `at an annual base rent of ${money(newRent)}${monthlyOf(newRent) ? ` (${monthlyOf(newRent)} per month)` : ''}`
    : escalationPct ? `with the rent adjusting by ${escalationPct}% per year`
    : 'on the terms set out in your lease';
  const subject = `Upcoming Lease Renewal — ${propertyName || 'your premises'} (term ends ${longDate(termEnd)})`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Upcoming renewal of your lease at ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `The current term of your lease at ${propertyName || 'the premises'} is approaching its end on ${longDate(termEnd)}. We're reaching out ahead of time so you have plenty of notice to plan.`,
      `Your lease includes ${optionLabel ? `${optionLabel} — ` : ''}${termPhrase} ${rentPhrase}. If you'd like to continue your tenancy, we'd be glad to move forward with the renewal.`,
      `Please let us know whether you intend to exercise this renewal${noticeByDate ? ` by ${longDate(noticeByDate)}` : ' at your earliest convenience'}, so we can prepare the paperwork. If you have any questions or would like to discuss the terms, just reply to this email or contact our office.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}

// Sent when a lease is NOT being renewed: a formal notice that the current term will
// conclude on its end date and will not be renewed. Neutral wording — reads the same
// whether the tenant or the landlord chose not to renew.
export function buildNonRenewalEmail({ business, tenant_name, contact_name, tenant_email, propertyName, leaseEnd }) {
  const subject = `Notice of Lease Expiration — ${propertyName || 'your premises'} (lease ends ${longDate(leaseEnd)})`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Expiration of your lease at ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `This letter serves as formal notice that the current term of your lease at ${propertyName || 'the premises'} will conclude on ${longDate(leaseEnd)} and will not be renewed. Please plan accordingly for the end of the term.`,
      `As the lease approaches its expiration, we ask that you arrange to vacate and return the premises in the condition required under the lease, including any move-out and restoration obligations. We will be in touch to coordinate a final walk-through, the return of keys, and reconciliation of the security deposit.`,
      `We sincerely thank you for your tenancy. If you have any questions about the wind-down or the steps ahead, please contact our office and we will be glad to assist.`,
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

// Sent when a tenant's certificate of insurance ON FILE has expired (or is about to):
// names the policy on file + its expiry and asks for the RENEWED certificate. Used by
// the "Request renewed certificate" button on an expiring/expired policy and by the ✉
// on the tenant insurance-expiry / chase-up alerts.
export function buildInsuranceRenewalRequestEmail({ business, tenant_name, contact_name, tenant_email, propertyName, insurer, expiryDate, expired }) {
  const company = business?.company_name || 'the landlord';
  const policyRef = insurer ? `your policy with ${insurer}` : 'the certificate of insurance on file';
  const past = expired || (expiryDate && /^\d{4}-\d{2}-\d{2}$/.test(expiryDate) && new Date(expiryDate + 'T12:00:00') < new Date());
  // Two tones: a lapsed policy is a compliance ask ("renewed certificate"); a policy still
  // on file is a routine "keep our copy current" ask, so the wording never sounds alarmist
  // when the coverage is far from expiring.
  const subject = past
    ? `Expired Certificate of Insurance — ${propertyName || 'your premises'}${expiryDate ? ` (expired ${longDate(expiryDate)})` : ''}`
    : `Certificate of Insurance — updated copy requested — ${propertyName || 'your premises'}`;
  const situation = past
    ? `Our records show that ${policyRef} for ${propertyName || 'the premises'} expired${expiryDate ? ` on ${longDate(expiryDate)}` : ''}. Your lease requires that coverage be maintained continuously, so we're writing to ask for the renewed certificate.`
    : `We have ${policyRef} for ${propertyName || 'the premises'} on file${expiryDate ? `, with coverage through ${longDate(expiryDate)}` : ''}. To keep our records current, we're writing to request your most recent certificate of insurance.`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: ${past ? 'Renewed' : 'Current'} certificate of insurance for ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      situation,
      `Please send an updated certificate of insurance showing the current policy period, and confirm it names ${company} as an additional insured with the coverage limits required under the lease. This keeps your file current and your coverage in compliance with the lease.`,
      `You can reply to this email with the certificate attached, or have your insurance agent send it directly to our office. Thank you for your prompt attention — please let us know if you have any questions.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}

// Sent when the tenant's certificate ON FILE does not name the landlord as
// additional insured: asks for a corrected certificate / endorsement. Powers the
// "✉ Request corrected certificate" button on the additional-insured notice.
export function buildAdditionalInsuredRequestEmail({ business, tenant_name, contact_name, tenant_email, propertyName, insurer, expiryDate }) {
  const company = business?.company_name || 'the landlord';
  const policyRef = insurer ? `your policy with ${insurer}` : 'the certificate of insurance on file';
  const subject = `Additional Insured Endorsement Needed — ${propertyName || 'your premises'}`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Additional insured endorsement for ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `Our records show that ${policyRef} for ${propertyName || 'the premises'}${expiryDate ? `, with coverage through ${longDate(expiryDate)},` : ''} does not name ${company} as an additional insured, as required under the insurance provisions of your lease.`,
      `Please have your insurance agent issue an updated certificate of insurance (or endorsement) naming ${company} as an additional insured, and send us the corrected copy for our files. No change to your coverage dates is needed — only the additional-insured designation.`,
      `You can reply to this email with the corrected certificate attached, or have your agent send it directly to our office. Thank you for your prompt attention — please let us know if you have any questions.`,
    ],
  });
  return { subject, body, to: tenant_email || '' };
}

// Sent to a service VENDOR (not a tenant) when their contract is nearing its end date:
// a friendly note to line up a renewal or an updated proposal before service lapses.
export function buildContractRenewalEmail({ business, vendorName, vendorEmail, contractName, propertyName, endDate }) {
  const what = contractName || 'our service agreement';
  const subject = `Service Contract Renewal — ${contractName || 'service agreement'} (expires ${longDate(endDate)})`;
  const body = letter({
    business,
    toBlock: [
      vendorName || contractName || 'Service Provider',
      propertyName ? `Service provider at ${propertyName}` : null,
      vendorEmail || null,
    ],
    reLine: `RE: Renewal of ${what}${propertyName ? ` at ${propertyName}` : ''}`,
    paragraphs: [
      `Dear ${vendorName || 'Service Provider'},`,
      `Our records show that ${what}${propertyName ? ` for ${propertyName}` : ''} is set to expire on ${longDate(endDate)}. We'd like to arrange to renew the agreement so service continues without interruption.`,
      `Please let us know your availability to review the terms — including pricing and scope for the coming term — at your earliest convenience. If you have an updated proposal or renewal contract ready, feel free to send it along in reply.`,
      `Thank you for your service. We look forward to continuing to work with you.`,
    ],
  });
  return { subject, body, to: vendorEmail || '' };
}

// Sent when a rent payment came in SHORT of what the ledger projects for a month —
// most often because a scheduled rent adjustment (escalation) took effect and the
// tenant is still remitting the old amount. Names the month, what was received, the
// scheduled figure, and the difference, and asks them to true it up. The projected
// figure is already escalation-aware, so escalations are referenced generically (no
// per-lease step math needed here). Landlord-initiated — nothing auto-sends.
export function buildPaymentShortfallEmail({ business, tenant_name, contact_name, tenant_email, propertyName, monthLabel, scheduled, received, shortfall, paidDate }) {
  const gap = money(Math.abs(Number(shortfall) || (Number(scheduled) || 0) - (Number(received) || 0)));
  const forMonth = monthLabel ? ` for ${monthLabel}` : '';
  const subject = `Rent Payment Short of the Scheduled Amount — ${propertyName || 'your premises'}${monthLabel ? ` (${monthLabel})` : ''}`;
  const body = letter({
    business,
    toBlock: toBlockFor({ contact_name, tenant_name, tenant_email, propertyName }),
    reLine: `RE: Rent payment${forMonth} at ${propertyName || 'the premises'}`,
    paragraphs: [
      `Dear ${contact_name || tenant_name || 'Tenant'},`,
      `Thank you for your recent rent payment${forMonth}${paidDate ? ` received on ${longDate(paidDate)}` : ''}. In reconciling it against your lease, we found that the amount came in below the scheduled rent${forMonth}.`,
      `We received ${money(received)}, while the scheduled rent${forMonth} is ${money(scheduled)}, leaving a balance of ${gap}. This most often happens when a scheduled rent adjustment (an escalation provided for in your lease) has taken effect and the prior amount is still being remitted.`,
      `Please arrange to remit the remaining ${gap} and update your records so future payments reflect the current scheduled rent. If you believe this is in error or would like us to walk through the figures, just reply to this email or contact our office — we're glad to help.`,
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

// Year-end CAM & tax reconciliation statement: the tenant paid ESTIMATED additional
// rent (CAM / property tax / roof where applicable) during the year; this email
// carries an invoice-style STATEMENT document (letterhead, billed-vs-actual
// breakdown, BALANCE DUE / REFUND DUE line) followed by a short letter explaining
// the outcome from those numbers. `lines` = [{ label, est, actual }] (roof included
// only when it was in play); `diff` = actual − estimate (signed); `direction` =
// tenant_owes | landlord_owes | even. Like every letter, nothing auto-sends.
//
// FORMAT RULE (same as the invoice template): must read right in a PROPORTIONAL
// font — Gmail's compose window and received mail don't render space-padded
// columns, so each charge is ONE line with its billed / actual / difference
// figures labeled in place. Never two spaces in a row, no padStart/padEnd.
export function buildCamReconciliationEmail({ business, tenant_name, contact_name, tenant_email, propertyName, year, lines, diff, direction }) {
  const amount = money(Math.abs(Number(diff) || 0));
  const rows = (lines || []).map((l) => {
    const est = Number(l.est) || 0;
    const actual = Number(l.actual) || 0;
    return { label: String(l.label), est, actual, d: Math.round((actual - est) * 100) / 100 };
  });
  const estTotal = rows.reduce((s, r) => s + r.est, 0);
  const actualTotal = rows.reduce((s, r) => s + r.actual, 0);
  const signed = (d) => (d > 0 ? `+${money(d)}` : d < 0 ? `−${money(Math.abs(d))}` : money(0));
  const row = (label, est, actual, d) => `${label} — billed ${money(est)} · actual ${money(actual)} · difference ${signed(d)}`;

  const stmtNo = `REC-${year}-${(tenant_name || 'TEN').replace(/\W+/g, '').slice(0, 4).toUpperCase()}`;
  const contact = [business?.contact_email, business?.contact_phone].filter(Boolean).join(' · ');

  const doc = [];
  [business?.company_name, business?.address, contact].filter(Boolean).forEach((l) => doc.push(l));
  if (doc.length) doc.push('');
  doc.push(`RECONCILIATION STATEMENT ${stmtNo}`);
  doc.push(`Statement date: ${today()}`);
  doc.push(`Period: Calendar year ${year}`);
  doc.push('');
  doc.push('BILL TO');
  doc.push([contact_name, tenant_name].filter(Boolean).join(' — ') || 'Tenant');
  if (tenant_email) doc.push(tenant_email);
  if (propertyName) doc.push(`Premises: ${propertyName}`);
  doc.push('');
  doc.push('CHARGES — BILLED (EST.) VS ACTUAL');
  rows.forEach((r) => doc.push(`• ${row(r.label, r.est, r.actual, r.d)}`));
  doc.push(row('TOTAL', estTotal, actualTotal, Number(diff) || 0));
  doc.push('');
  const dueLabel = direction === 'landlord_owes' ? 'REFUND DUE TO TENANT' : 'BALANCE DUE';
  doc.push(`${dueLabel}: ${direction === 'even' ? money(0) : amount}`);

  const settle =
    direction === 'tenant_owes'
      ? `As the statement shows, the actual expenses came in ${amount} above the estimates you were billed, leaving a balance of ${amount} due. Please remit this amount within 30 days of the date of this statement.`
      : direction === 'landlord_owes'
        ? `As the statement shows, the actual expenses came in below the estimates you were billed, so a refund of ${amount} is due to you. We will issue the refund promptly — no action is needed on your part.`
        : `As the statement shows, the actual expenses matched the estimates you were billed, so no balance is due in either direction and your account is settled for the year.`;

  const chargeNames = rows
    .map((r) => (r.label === 'CAM' || r.label === 'CAM & tax' ? r.label.replace(' & ', ' and ') : r.label.toLowerCase()))
    .join(', ');
  const subject = `CAM & Tax Reconciliation — ${propertyName || 'your premises'} (${year})`;
  const body = [
    ...doc,
    '',
    `Dear ${contact_name || tenant_name || 'Tenant'},`,
    '',
    `As provided under your lease at ${propertyName || 'the premises'}, the additional rent you paid during ${year} (${chargeNames}) was billed from estimated figures. Now that the year's actual expenses are final, we have reconciled those estimates against your proportionate share — the statement above shows each charge side by side, with the difference on the right.`,
    '',
    settle,
    '',
    `Supporting detail for the year's expenses is available on request. If you have any questions about this reconciliation, please contact our office and we will be glad to walk through the figures with you.`,
    '',
    'Sincerely,',
    business?.company_name || 'Property Management',
    ...(contact ? [contact] : []),
  ].join('\n');
  return { subject, body, to: tenant_email || '' };
}
